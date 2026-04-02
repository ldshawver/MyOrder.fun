import { Router, type IRouter } from "express";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import {
  db,
  ordersTable,
  orderItemsTable,
  orderNotesTable,
  catalogItemsTable,
  usersTable,
  notificationsTable,
  labTechShiftsTable,
} from "@workspace/db";
import { sendSms, smsOrderConfirmation, smsNewOrderAlert, smsStatusUpdate, smsTrackingReady } from "../lib/sms";
import {
  ListOrdersQueryParams,
  ListOrdersResponse,
  CreateOrderBody,
  GetOrderParams,
  GetOrderResponse,
  UpdateOrderStatusParams,
  UpdateOrderStatusBody,
  UpdateOrderStatusResponse,
  GetOrderSummaryResponse,
  GetRecentOrdersQueryParams,
  GetRecentOrdersResponse,
  GetOrderNotesParams,
  GetOrderNotesResponse,
  AddOrderNoteParams,
  AddOrderNoteBody,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

async function buildOrderResponse(order: typeof ordersTable.$inferSelect) {
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const customer = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1);
  const c = customer[0];
  return {
    id: order.id,
    tenantId: order.tenantId,
    customerId: order.customerId,
    customerName: c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() : "",
    customerEmail: c?.email ?? "",
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentToken: order.paymentToken,
    subtotal: parseFloat(order.subtotal as string),
    tax: parseFloat((order.tax as string) ?? "0"),
    total: parseFloat(order.total as string),
    shippingAddress: order.shippingAddress,
    notes: order.notes,
    trackingUrl: order.trackingUrl ?? null,
    items: items.map(i => ({
      id: i.id,
      catalogItemId: i.catalogItemId,
      catalogItemName: i.catalogItemName,
      quantity: i.quantity,
      unitPrice: parseFloat(i.unitPrice as string),
      totalPrice: parseFloat(i.totalPrice as string),
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

// GET /api/orders
router.get("/orders", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (!actor.tenantId) {
    res.status(400).json({ error: "No tenant" });
    return;
  }

  let rows = await db.select().from(ordersTable)
    .where(eq(ordersTable.tenantId, actor.tenantId))
    .orderBy(desc(ordersTable.createdAt));

  // Customers see only their own orders
  if (actor.role === "customer") {
    rows = rows.filter(o => o.customerId === actor.id);
  }
  if (query.data.status) rows = rows.filter(o => o.status === query.data.status);
  if (query.data.customerId) rows = rows.filter(o => o.customerId === query.data.customerId);

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 20;
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);
  const orderObjs = await Promise.all(paged.map(buildOrderResponse));

  res.json(ListOrdersResponse.parse({ orders: orderObjs, total, page, limit }));
});

// POST /api/orders
router.post("/orders", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!actor.tenantId) {
    res.status(400).json({ error: "No tenant" });
    return;
  }
  const body = CreateOrderBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Verify all catalog items belong to tenant and compute totals
  let subtotal = 0;
  const resolvedItems: Array<{ catalogItem: typeof catalogItemsTable.$inferSelect; quantity: number }> = [];
  for (const item of body.data.items) {
    const [ci] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, item.catalogItemId)).limit(1);
    if (!ci || ci.tenantId !== actor.tenantId) {
      res.status(400).json({ error: `Catalog item ${item.catalogItemId} not found in your catalog` });
      return;
    }
    if (!ci.isAvailable) {
      res.status(400).json({ error: `Item "${ci.name}" is not available` });
      return;
    }
    const price = parseFloat(ci.price as string);
    subtotal += price * item.quantity;
    resolvedItems.push({ catalogItem: ci, quantity: item.quantity });
  }

  const tax = subtotal * 0.08; // 8% tax
  const total = subtotal + tax;

  // Assign to active lab tech shift (or default tech if no shift active)
  const [activeShift] = await db
    .select()
    .from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.tenantId, actor.tenantId), eq(labTechShiftsTable.status, "active")))
    .orderBy(desc(labTechShiftsTable.clockedInAt))
    .limit(1);

  let assignedTechId: number | null = null;
  let assignedShiftId: number | null = null;
  if (activeShift) {
    assignedTechId = activeShift.techId;
    assignedShiftId = activeShift.id;
  } else {
    const [defaultTech] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, actor.tenantId), eq(usersTable.isDefaultTech, true)))
      .limit(1);
    if (defaultTech) assignedTechId = defaultTech.id;
  }

  const [order] = await db.insert(ordersTable).values({
    tenantId: actor.tenantId,
    customerId: actor.id,
    status: "pending",
    paymentStatus: "unpaid",
    subtotal: String(subtotal.toFixed(2)),
    tax: String(tax.toFixed(2)),
    total: String(total.toFixed(2)),
    shippingAddress: body.data.shippingAddress ?? null,
    notes: body.data.notes ?? null,
    assignedTechId,
    assignedShiftId,
  }).returning();

  for (const { catalogItem: ci, quantity } of resolvedItems) {
    const unitPrice = parseFloat(ci.price as string);
    await db.insert(orderItemsTable).values({
      orderId: order.id,
      catalogItemId: ci.id,
      catalogItemName: ci.name,
      quantity,
      unitPrice: String(unitPrice.toFixed(2)),
      totalPrice: String((unitPrice * quantity).toFixed(2)),
    });
  }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "CREATE_ORDER",
    tenantId: actor.tenantId,
    resourceType: "order",
    resourceId: String(order.id),
    metadata: { total, itemCount: resolvedItems.length },
    ipAddress: req.ip,
  });

  // SMS: confirm to customer + alert assigned tech (fire-and-forget)
  try {
    const [customer] = await db.select({ contactPhone: usersTable.contactPhone, firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable).where(eq(usersTable.id, actor.id)).limit(1);
    const customerPhone = customer?.contactPhone;
    const itemCount = resolvedItems.reduce((s, r) => s + r.quantity, 0);
    await sendSms(customerPhone, smsOrderConfirmation(order.id, total, itemCount));

    if (assignedTechId) {
      const [tech] = await db.select({ contactPhone: usersTable.contactPhone }).from(usersTable).where(eq(usersTable.id, assignedTechId)).limit(1);
      const customerName = customer ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() : "";
      await sendSms(tech?.contactPhone, smsNewOrderAlert(order.id, customerName, total, itemCount));
    }
  } catch { /* non-critical */ }

  const orderObj = await buildOrderResponse(order);
  res.status(201).json(GetOrderResponse.parse(orderObj));
});

// GET /api/orders/summary
router.get("/orders/summary", requireRole("tenant_admin", "global_admin", "staff"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!actor.tenantId) {
    res.status(400).json({ error: "No tenant" });
    return;
  }
  const orders = await db.select().from(ordersTable).where(eq(ordersTable.tenantId, actor.tenantId));
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());

  const statusMap = new Map<string, { count: number; revenue: number }>();
  for (const o of orders) {
    const s = o.status;
    const existing = statusMap.get(s) ?? { count: 0, revenue: 0 };
    existing.count += 1;
    if (o.paymentStatus === "paid") existing.revenue += parseFloat(o.total as string);
    statusMap.set(s, existing);
  }

  const totalRevenue = orders.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + parseFloat(o.total as string), 0);
  const revenueToday = orders.filter(o => o.paymentStatus === "paid" && new Date(o.createdAt) >= startOfDay).reduce((s, o) => s + parseFloat(o.total as string), 0);
  const revenueThisWeek = orders.filter(o => o.paymentStatus === "paid" && new Date(o.createdAt) >= startOfWeek).reduce((s, o) => s + parseFloat(o.total as string), 0);
  const averageOrderValue = orders.length > 0 ? totalRevenue / orders.filter(o => o.paymentStatus === "paid").length : 0;

  const byStatus = [...statusMap.entries()].map(([status, d]) => ({ status, count: d.count, revenue: d.revenue }));

  res.json(GetOrderSummaryResponse.parse({ byStatus, totalRevenue, revenueToday, revenueThisWeek, averageOrderValue: averageOrderValue || 0 }));
});

// GET /api/orders/recent
router.get("/orders/recent", requireRole("tenant_admin", "global_admin", "staff"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!actor.tenantId) {
    res.status(400).json({ error: "No tenant" });
    return;
  }
  const query = GetRecentOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = query.data.limit ?? 10;
  const orders = await db.select().from(ordersTable)
    .where(eq(ordersTable.tenantId, actor.tenantId))
    .orderBy(desc(ordersTable.createdAt))
    .limit(limit);
  const orderObjs = await Promise.all(orders.map(buildOrderResponse));
  res.json(GetRecentOrdersResponse.parse({ orders: orderObjs, total: orderObjs.length, page: 1, limit }));
});

// GET /api/orders/:id
router.get("/orders/:id", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetOrderParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, params.data.id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (actor.role !== "global_admin" && order.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (actor.role === "customer" && order.customerId !== actor.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orderObj = await buildOrderResponse(order);
  res.json(GetOrderResponse.parse(orderObj));
});

// PATCH /api/orders/:id
router.patch("/orders/:id", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateOrderStatusParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateOrderStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, params.data.id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (actor.role !== "global_admin" && order.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [updated] = await db.update(ordersTable)
    .set({ status: body.data.status, notes: body.data.notes ?? order.notes })
    .where(eq(ordersTable.id, params.data.id))
    .returning();

  // In-app notification + SMS to customer
  try {
    await db.insert(notificationsTable).values({
      userId: order.customerId,
      type: "order_status",
      title: `Order #${order.id} status updated`,
      message: `Your order status changed to ${body.data.status}.`,
      resourceType: "order",
      resourceId: order.id,
    });
  } catch { /* non-critical */ }
  try {
    const [customer] = await db.select({ contactPhone: usersTable.contactPhone })
      .from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1);
    await sendSms(customer?.contactPhone, smsStatusUpdate(order.id, body.data.status));
  } catch { /* non-critical */ }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "UPDATE_ORDER_STATUS",
    tenantId: actor.tenantId,
    resourceType: "order",
    resourceId: String(order.id),
    metadata: { newStatus: body.data.status, previousStatus: order.status },
    ipAddress: req.ip,
  });

  const orderObj = await buildOrderResponse(updated);
  res.json(UpdateOrderStatusResponse.parse(orderObj));
});

// GET /api/orders/:id/notes
router.get("/orders/:id/notes", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetOrderNotesParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, params.data.id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (actor.role !== "global_admin" && order.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  let notes = await db.select().from(orderNotesTable).where(eq(orderNotesTable.orderId, params.data.id)).orderBy(desc(orderNotesTable.createdAt));
  // Customers cannot see internal notes
  if (actor.role === "customer") {
    notes = notes.filter(n => n.isInternal !== "true");
  }

  const authorIds = [...new Set(notes.map(n => n.authorId))];
  const authors = authorIds.length > 0
    ? await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable)
        .where(sql`${usersTable.id} = ANY(${sql.raw(`ARRAY[${authorIds.join(",")}]`)})`)
    : [];
  const authorMap = new Map(authors.map(a => [a.id, a]));

  const mapped = notes.map(n => {
    const a = authorMap.get(n.authorId);
    return {
      id: n.id,
      orderId: n.orderId,
      authorId: n.authorId,
      authorName: a ? `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || a.email : "Unknown",
      content: n.content,
      isEncrypted: n.isEncrypted === "true",
      isInternal: n.isInternal === "true",
      createdAt: n.createdAt,
    };
  });

  res.json(GetOrderNotesResponse.parse({ notes: mapped }));
});

// PATCH /api/orders/:id/tracking — staff/admin only
router.patch("/orders/:id/tracking", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = parseInt(raw, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const { trackingUrl } = req.body as { trackingUrl?: string };
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (actor.role !== "global_admin" && order.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const [updated] = await db.update(ordersTable)
    .set({ trackingUrl: trackingUrl ?? null })
    .where(eq(ordersTable.id, orderId))
    .returning();
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_TRACKING_UPDATED", tenantId: order.tenantId,
    resourceType: "order", resourceId: String(orderId),
    metadata: { trackingUrl }, ipAddress: req.ip,
  });

  // SMS customer with tracking link
  if (trackingUrl) {
    try {
      const [customer] = await db.select({ contactPhone: usersTable.contactPhone })
        .from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1);
      await sendSms(customer?.contactPhone, smsTrackingReady(orderId, trackingUrl));
    } catch { /* non-critical */ }
  }

  res.json({ trackingUrl: updated.trackingUrl });
});

// POST /api/orders/:id/notes
router.post("/orders/:id/notes", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = AddOrderNoteParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AddOrderNoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, params.data.id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (actor.role !== "global_admin" && order.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Customers cannot add internal notes
  const isInternal = (actor.role !== "customer") && (body.data.isInternal ?? false);

  const [note] = await db.insert(orderNotesTable).values({
    orderId: params.data.id,
    authorId: actor.id,
    content: body.data.content,
    isEncrypted: String(body.data.isEncrypted ?? false),
    isInternal: String(isInternal),
  }).returning();

  res.status(201).json({
    id: note.id,
    orderId: note.orderId,
    authorId: note.authorId,
    authorName: `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || actor.email,
    content: note.content,
    isEncrypted: note.isEncrypted === "true",
    isInternal: note.isInternal === "true",
    createdAt: note.createdAt,
  });
});

export default router;
