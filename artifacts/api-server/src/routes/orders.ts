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
  inventoryTemplatesTable,
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
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { normalizeCheckoutCart, buildMerchantPayloadLines, type NormalizedCartLine } from "../lib/checkoutNormalizer";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

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
  let rows = await db.select().from(ordersTable)
    .orderBy(desc(ordersTable.createdAt));

  // Customers see only their own orders
  if (actor.role === "user") {
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
    if (!ci) {
      res.status(400).json({ error: `Catalog item ${item.catalogItemId} not found` });
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

  // Dual-brand normalization: validates merchant fields, classifies local_mapped vs woo,
  // and guarantees Alavont names never appear in processor payloads
  let normalizedLines: NormalizedCartLine[];
  try {
    normalizedLines = await normalizeCheckoutCart(body.data.items);
  } catch (normErr: any) {
    res.status(400).json({ error: normErr?.message ?? "Cart validation failed" });
    return;
  }

  const tax = subtotal * 0.08; // 8% tax
  const total = subtotal + tax;

  const houseTenantId = await getHouseTenantId();

  // Assign to active lab tech shift (or default tech if no shift active)
  const [activeShift] = await db
    .select()
    .from(labTechShiftsTable)
    .where(eq(labTechShiftsTable.status, "active"))
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
      .where(eq(usersTable.isDefaultTech, true))
      .limit(1);
    if (defaultTech) assignedTechId = defaultTech.id;
  }

  const [order] = await db.insert(ordersTable).values({
    tenantId: houseTenantId,
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

  // Persist dual-brand snapshots on the order for auditability
  const alavontCartSnapshot = normalizedLines.map(l => ({
    catalogItemId: l.catalog_item_id,
    alavontName: l.receipt_alavont_name,
    quantity: l.quantity,
    unitPrice: l.unit_price,
  }));
  const luciferCheckoutSnapshot = normalizedLines.map(l => ({
    catalogItemId: l.catalog_item_id,
    luciferCruzName: l.merchant_name,
    sourceType: l.source_type,
    wooProductId: l.woo_product_id,
    wooVariationId: l.woo_variation_id,
    quantity: l.quantity,
    unitPrice: l.unit_price,
  }));

  await db.update(ordersTable).set({ alavontCartSnapshot, luciferCheckoutSnapshot }).where(eq(ordersTable.id, order.id));

  // Insert order items using normalized line data
  // catalogItemName = Alavont display name (internal), luciferCruzName = LC merchant name (processor)
  for (const line of normalizedLines) {
    await db.insert(orderItemsTable).values({
      orderId: order.id,
      catalogItemId: line.catalog_item_id,
      catalogItemName: line.catalog_display_name,        // Alavont name for internal records
      quantity: line.quantity,
      unitPrice: String(line.unit_price.toFixed(2)),
      totalPrice: String((line.unit_price * line.quantity).toFixed(2)),
      // Dual-brand snapshot columns
      alavontName: line.receipt_alavont_name,
      luciferCruzName: line.merchant_name,               // LC merchant name — never Alavont
      receiptName: line.receipt_name ?? line.merchant_name,
      labelName: line.label_name ?? line.merchant_name,
      labName: line.lab_name ?? line.receipt_alavont_name,
      // CJ Dropshipping linkage — persisted so post-payment dispatch can use stored values
      wooProductId: line.woo_product_id ?? null,
      wooVariationId: line.woo_variation_id ?? null,
    });
  }

  // Merchant payload audit: log LC-safe line items that would go to Stripe/WooCommerce
  try {
    const merchantLines = buildMerchantPayloadLines(normalizedLines);
    logger.info(
      { orderId: order.id, merchantLines, actorId: actor.id },
      "MERCHANT_PAYLOAD_AUDIT: LC-safe names for processor — Alavont names NOT present"
    );
  } catch { /* non-critical audit log */ }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "CREATE_ORDER",
    resourceType: "order",
    resourceId: String(order.id),
    metadata: { total, itemCount: normalizedLines.length },
    ipAddress: req.ip,
  });

  // SMS: confirm to customer + alert assigned tech (fire-and-forget)
  let customerName = "";
  try {
    const [customer] = await db.select({ contactPhone: usersTable.contactPhone, firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable).where(eq(usersTable.id, actor.id)).limit(1);
    const customerPhone = customer?.contactPhone;
    const itemCount = normalizedLines.reduce((s, l) => s + l.quantity, 0);
    customerName = customer ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() : "";
    await sendSms(customerPhone, smsOrderConfirmation(order.id, total, itemCount));

    if (assignedTechId) {
      const [tech] = await db.select({ contactPhone: usersTable.contactPhone }).from(usersTable).where(eq(usersTable.id, assignedTechId)).limit(1);
      await sendSms(tech?.contactPhone, smsNewOrderAlert(order.id, customerName, total, itemCount));
    }
  } catch { /* non-critical */ }

  // Print: enqueue print jobs (fire-and-forget)
  try {
    const { enqueueOrderPrintJobs } = await import("../lib/printService");
    await enqueueOrderPrintJobs({
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes,
      subtotal: order.subtotal as string,
      tax: order.tax as string,
      total: order.total as string,
      createdAt: order.createdAt,
      customerName,
      items: normalizedLines.map(l => ({
        quantity: l.quantity,
        catalogItemName: l.catalog_display_name,  // Alavont display name (internal)
        alavontName: l.receipt_alavont_name,
        luciferCruzName: l.merchant_name,          // LC merchant name for receipt mode
        unitPrice: String(l.unit_price.toFixed(2)),
        totalPrice: String((l.unit_price * l.quantity).toFixed(2)),
      })),
    });
  } catch { /* non-critical */ }

  const orderObj = await buildOrderResponse(order);
  res.status(201).json(GetOrderResponse.parse(orderObj));
});

// GET /api/orders/summary
router.get("/orders/summary", requireRole("admin", "supervisor", "business_sitter"), async (_req, res): Promise<void> => {
  const orders = await db.select().from(ordersTable);
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
router.get("/orders/recent", requireRole("admin", "supervisor", "business_sitter"), async (req, res): Promise<void> => {
  const query = GetRecentOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = query.data.limit ?? 10;
  const orders = await db.select().from(ordersTable)
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
  if (actor.role === "user" && order.customerId !== actor.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orderObj = await buildOrderResponse(order);
  res.json(GetOrderResponse.parse(orderObj));
});

// PATCH /api/orders/:id
router.patch("/orders/:id", requireRole("business_sitter", "supervisor", "admin"), async (req, res): Promise<void> => {
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
  const [updated] = await db.update(ordersTable)
    .set({ status: body.data.status, notes: body.data.notes ?? order.notes })
    .where(eq(ordersTable.id, params.data.id))
    .returning();

  // Auto-deduct raw material inventory when order is fulfilled/completed
  if (
    ((body.data.status as string) === "fulfilled" || (body.data.status as string) === "completed") &&
    (order.status as string) !== "fulfilled" && (order.status as string) !== "completed"
  ) {
    try {
      const orderItems = await db
        .select()
        .from(orderItemsTable)
        .where(eq(orderItemsTable.orderId, order.id));
      for (const item of orderItems) {
        if (!item.catalogItemId) continue;
        const templates = await db
          .select()
          .from(inventoryTemplatesTable)
          .where(
            and(
              eq(inventoryTemplatesTable.catalogItemId, item.catalogItemId),
              eq(inventoryTemplatesTable.isActive, true),
            )
          );
        for (const tmpl of templates) {
          const deductPer = parseFloat(String(tmpl.deductionQuantityPerSale ?? 1));
          const qty = parseFloat(String(item.quantity ?? 1));
          const totalDeduct = deductPer * qty;
          const currentStockVal = tmpl.currentStock != null
            ? parseFloat(String(tmpl.currentStock))
            : parseFloat(String(tmpl.startingQuantityDefault ?? 0));
          const newStock = currentStockVal - totalDeduct;
          await db
            .update(inventoryTemplatesTable)
            .set({ currentStock: String(newStock) })
            .where(eq(inventoryTemplatesTable.id, tmpl.id));
        }
      }
    } catch { /* non-critical */ }
  }

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
  let notes = await db.select().from(orderNotesTable).where(eq(orderNotesTable.orderId, params.data.id)).orderBy(desc(orderNotesTable.createdAt));
  // Customers cannot see internal notes
  if (actor.role === "user") {
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
router.patch("/orders/:id/tracking", requireRole("business_sitter", "supervisor", "admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = parseInt(raw, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const { trackingUrl } = req.body as { trackingUrl?: string };
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  const [updated] = await db.update(ordersTable)
    .set({ trackingUrl: trackingUrl ?? null })
    .where(eq(ordersTable.id, orderId))
    .returning();
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_TRACKING_UPDATED",
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

// POST /api/orders/:id/fulfillment — set fulfillment status (staff/admin)
router.post("/orders/:id/fulfillment", requireRole("business_sitter", "supervisor", "admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }

  const { fulfillmentStatus } = req.body as { fulfillmentStatus?: string };
  const VALID = ["ready_behind_gate", "courier_arrived", "handed_off", "complete"];
  if (!fulfillmentStatus || !VALID.includes(fulfillmentStatus)) {
    res.status(400).json({ error: `fulfillmentStatus must be one of: ${VALID.join(", ")}` }); return;
  }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }

  const update: Partial<typeof ordersTable.$inferInsert> = { fulfillmentStatus };
  // Mark status as complete on certain transitions
  if (fulfillmentStatus === "handed_off" || fulfillmentStatus === "complete") {
    update.status = "completed";
  }

  const [updated] = await db.update(ordersTable).set(update).where(eq(ordersTable.id, orderId)).returning();

  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "UPDATE_FULFILLMENT_STATUS",
    resourceType: "order", resourceId: String(orderId),
    metadata: { fulfillmentStatus }, ipAddress: req.ip,
  });

  res.json({ id: updated.id, fulfillmentStatus: updated.fulfillmentStatus, status: updated.status });
});

// POST /api/orders/:id/purge — purge order data (admin only)
router.post("/orders/:id/purge", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }

  const { mode } = req.body as { mode?: string };
  const purgeMode = mode || "partial";

  const { randomBytes } = await import("crypto");
  const auditToken = order.auditToken || randomBytes(16).toString("hex");

  if (purgeMode === "immediate") {
    // Hard delete everything except a stub with the audit token
    await db.delete(orderNotesTable).where(eq(orderNotesTable.orderId, orderId));
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));
    await db.update(ordersTable).set({
      notes: null, shippingAddress: null, alavontCartSnapshot: null,
      luciferCheckoutSnapshot: null, purgedAt: new Date(), auditToken,
      status: "purged",
    }).where(eq(ordersTable.id, orderId));
  } else if (purgeMode === "partial") {
    // Remove PII only, keep anonymous financial record
    await db.delete(orderNotesTable).where(eq(orderNotesTable.orderId, orderId));
    await db.update(ordersTable).set({
      notes: null, shippingAddress: null, alavontCartSnapshot: null,
      luciferCheckoutSnapshot: null, purgedAt: new Date(), auditToken,
      status: "purged",
    }).where(eq(ordersTable.id, orderId));
  } else {
    // delayed — just mark for purge, background job handles it
    await db.update(ordersTable).set({ purgedAt: new Date(), auditToken, status: "pending_purge" })
      .where(eq(ordersTable.id, orderId));
  }

  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_PURGED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { purgeMode, auditToken }, ipAddress: req.ip,
  });

  res.json({ success: true, purgeMode, auditToken });
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
  // Staff can add internal notes; regular users cannot
  const isInternal = (actor.role !== "user") && (body.data.isInternal ?? false);

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
