import { Router, type IRouter } from "express";
import { eq, and, desc, lt, isNotNull, notInArray, or, sql } from "drizzle-orm";
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
import { decideRouting, reassignOrder, listActiveCsrs } from "../lib/orderRouting";
import { publishOrderEvent, subscribe, getRecentEventsForClient } from "../lib/orderEvents";

const router: IRouter = Router();

// ─── SSE: realtime order events ──────────────────────────────────────────────
// Mounted BEFORE the global router.use() auth chain so we can short-circuit
// when EventSource (which cannot send Authorization headers) authenticates
// via the Clerk cookie session.
router.get(
  "/orders/stream",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  (req, res): void => {
    const actor = req.dbUser!;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ userId: actor.id, role: actor.role })}\n\n`);

    const teardown = subscribe({ res, userId: actor.id, role: actor.role });
    const keepalive = setInterval(() => {
      try { res.write(`: keepalive\n\n`); } catch { /* ignore */ }
    }, 25_000);
    req.on("close", () => {
      clearInterval(keepalive);
      teardown();
      try { res.end(); } catch { /* ignore */ }
    });
  }
);

// SSE poll fallback: clients whose EventSource has dropped poll this every
// ~10 seconds with `?since=<ISO>` to recover any events they missed. Strict
// server-side scoping is reused so no extra leak surface is added.
router.get(
  "/orders/recent-events",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  (req, res): void => {
    const actor = req.dbUser!;
    const since = typeof req.query.since === "string" ? req.query.since : new Date(Date.now() - 60_000).toISOString();
    const events = getRecentEventsForClient(
      { res, userId: actor.id, role: actor.role },
      since,
    );
    res.json({ events, serverTime: new Date().toISOString() });
  },
);

// GET /api/orders/delayed — supervisor list of orders past their ETA.
router.get(
  "/orders/delayed",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole("supervisor", "admin"),
  async (_req, res): Promise<void> => {
    // Push the delayed predicate into SQL so we don't load the full
    // orders table to filter in memory. Excludes terminal fulfillment
    // and terminal legacy status values to keep parity with the
    // previous in-memory filter.
    const now = new Date();
    const TERMINAL_FULFILLMENT = ["ready", "completed", "cancelled"];
    const TERMINAL_STATUS = ["completed", "cancelled", "ready", "delivered", "refunded"];
    const delayed = await db.select().from(ordersTable).where(
      and(
        isNotNull(ordersTable.estimatedReadyAt),
        lt(ordersTable.estimatedReadyAt, now),
        or(
          sql`${ordersTable.fulfillmentStatus} is null`,
          notInArray(ordersTable.fulfillmentStatus, TERMINAL_FULFILLMENT),
        ),
        notInArray(ordersTable.status, TERMINAL_STATUS),
      ),
    ).orderBy(desc(ordersTable.estimatedReadyAt));
    const out = await Promise.all(delayed.map(buildOrderResponse));
    res.json({ orders: out, total: out.length });
  },
);

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
    assignedCsrUserId: order.assignedCsrUserId ?? null,
    routeSource: order.routeSource ?? null,
    routedAt: order.routedAt ?? null,
    acceptedAt: order.acceptedAt ?? null,
    promisedMinutes: order.promisedMinutes ?? null,
    estimatedReadyAt: order.estimatedReadyAt ?? null,
    readyAt: order.readyAt ?? null,
    etaAdjustedBySupervisor: order.etaAdjustedBySupervisor ?? false,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
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

  // Customers see only their own orders.
  if (actor.role === "user") {
    rows = rows.filter(o => o.customerId === actor.id);
  }
  // CSR-tier roles see their own assignments + the General Account
  // fallback queue (assignedCsrUserId === null), matching the SSE
  // audience scoping so the listing UI cannot drift from realtime
  // alerts. Admin/supervisor still see everything.
  if (
    actor.role === "customer_service_rep" ||
    actor.role === "lab_tech" ||
    actor.role === "sales_rep" ||
    actor.role === "business_sitter"
  ) {
    rows = rows.filter(o => o.assignedCsrUserId === actor.id || o.assignedCsrUserId === null);
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
  } catch (normErr) {
    res.status(400).json({ error: (normErr as Error)?.message ?? "Cart validation failed" });
    return;
  }

  const tax = subtotal * 0.08; // 8% tax
  const total = subtotal + tax;

  const houseTenantId = await getHouseTenantId();

  // supervisor_manual_assignment; routes to assigned CSR + their active
  // shift, or to the General Account fallback queue).
  const routing = await decideRouting();

  // Legacy assignedTechId/assignedShiftId mirror the routing decision so
  // the existing FulfillmentCard / shift dashboards / legacy reports
  // keep working. When the routing decision is general_account (no CSR
  // owner), fall back to any active shift for both legacy fields —
  // routing ownership lives in assignedCsrUserId/routeSource, so the
  // legacy fallback does not muddy the new vocabulary.
  let assignedTechId: number | null = routing.assignedCsrUserId;
  let assignedShiftId: number | null = routing.assignedShiftId;
  if (!assignedTechId) {
    const [activeShift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.status, "active"))
      .orderBy(desc(labTechShiftsTable.clockedInAt))
      .limit(1);
    if (activeShift) {
      assignedTechId = activeShift.techId;
      assignedShiftId = activeShift.id;
    }
  }

  const now = new Date();
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
    assignedCsrUserId: routing.assignedCsrUserId,
    routeSource: routing.routeSource,
    routedAt: now,
    promisedMinutes: routing.promisedMinutes,
    estimatedReadyAt: routing.estimatedReadyAt,
    fulfillmentStatus: "submitted",
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
    metadata: { total, itemCount: normalizedLines.length, routeSource: routing.routeSource, assignedCsrUserId: routing.assignedCsrUserId },
    ipAddress: req.ip,
  });
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "ORDER_ASSIGNED",
    resourceType: "order",
    resourceId: String(order.id),
    metadata: { routeSource: routing.routeSource, assignedCsrUserId: routing.assignedCsrUserId, promisedMinutes: routing.promisedMinutes },
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

  // Realtime: notify CSR pool / supervisors. Server enforces scoping in
  // shouldDeliver — clients receive only what they're authorized to see.
  publishOrderEvent({
    type: "order.assigned",
    orderId: order.id,
    customerId: actor.id,
    assignedCsrUserId: routing.assignedCsrUserId,
    routeSource: routing.routeSource,
    customerName,
    total,
    itemCount: normalizedLines.reduce((s, l) => s + l.quantity, 0),
    routedAt: now.toISOString(),
    estimatedReadyAt: routing.estimatedReadyAt.toISOString(),
    promisedMinutes: routing.promisedMinutes,
  });

  res.status(201).json(GetOrderResponse.parse(orderObj));
});


function emitUpdated(o: typeof ordersTable.$inferSelect, reason: string) {
  publishOrderEvent({
    type: "order.updated",
    orderId: o.id,
    customerId: o.customerId,
    assignedCsrUserId: o.assignedCsrUserId ?? null,
    fulfillmentStatus: o.fulfillmentStatus ?? null,
    status: o.status,
    estimatedReadyAt: o.estimatedReadyAt ? o.estimatedReadyAt.toISOString() : null,
    acceptedAt: o.acceptedAt ? o.acceptedAt.toISOString() : null,
    etaAdjustedBySupervisor: o.etaAdjustedBySupervisor ?? false,
    routeSource: o.routeSource ?? null,
    reason,
  });
}

// POST /api/orders/:id/accept — CSR accepts a routed order
router.post("/orders/:id/accept", requireRole("customer_service_rep", "lab_tech", "sales_rep"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }

  // CSRs may only accept orders assigned to them or sitting in the General
  // Account fallback queue (assignedCsrUserId === null).
  if (actor.role === "customer_service_rep" || actor.role === "lab_tech" || actor.role === "sales_rep") {
    if (order.assignedCsrUserId != null && order.assignedCsrUserId !== actor.id) {
      res.status(403).json({ error: "Order is assigned to another rep" });
      return;
    }
  }
  if (order.acceptedAt) {
    res.status(409).json({ error: "Order already accepted", acceptedAt: order.acceptedAt });
    return;
  }
  if ((order.fulfillmentStatus ?? "submitted") !== "submitted") {
    res.status(409).json({
      error: "Order is not in submitted state",
      fulfillmentStatus: order.fulfillmentStatus,
    });
    return;
  }

  const now = new Date();
  // Atomic claim: include accepted_at IS NULL and fulfillment_status =
  // submitted in the WHERE clause so two CSRs racing on a general-queue
  // order cannot both win. The loser's UPDATE returns zero rows and we
  // 409 instead of double-accepting.
  const updatedRows = await db.update(ordersTable)
    .set({
      acceptedAt: now,
      status: "processing",
      fulfillmentStatus: "accepted",
      assignedCsrUserId: order.assignedCsrUserId ?? actor.id,
    })
    .where(and(
      eq(ordersTable.id, orderId),
      sql`${ordersTable.acceptedAt} is null`,
      eq(ordersTable.fulfillmentStatus, "submitted"),
    ))
    .returning();
  const updated = updatedRows[0];
  if (!updated) {
    res.status(409).json({ error: "Order was already accepted by another rep" });
    return;
  }

  emitUpdated(updated, "accepted");

  // If this was a general-queue order (no prior assignee), every CSR in the
  // pool received the original order.assigned event. The post-accept
  // order.updated above is now scoped to the accepting CSR only because
  // assignedCsrUserId is no longer null, so other CSR clients would keep a
  // stale alert. Broadcast a synthetic queue-clear event scoped to the
  // general queue (assignedCsrUserId: null) so they can drop it.
  if (order.assignedCsrUserId == null) {
    publishOrderEvent({
      type: "order.updated",
      orderId: updated.id,
      customerId: updated.customerId,
      assignedCsrUserId: null,
      fulfillmentStatus: updated.fulfillmentStatus ?? null,
      status: updated.status,
      estimatedReadyAt: updated.estimatedReadyAt ? updated.estimatedReadyAt.toISOString() : null,
      acceptedAt: updated.acceptedAt ? updated.acceptedAt.toISOString() : null,
      etaAdjustedBySupervisor: updated.etaAdjustedBySupervisor ?? false,
      routeSource: updated.routeSource ?? null,
      reason: "claimed_from_queue",
    });
  }

  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_ACCEPTED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { acceptedByUserId: actor.id }, ipAddress: req.ip,
  });

  res.json(await buildOrderResponse(updated));
});

// PATCH /api/orders/:id/eta — supervisor adjusts the customer hourglass
router.patch("/orders/:id/eta", requireRole("supervisor", "admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const { estimatedReadyAt, promisedMinutes } = req.body as { estimatedReadyAt?: string; promisedMinutes?: number };
  let when: Date;
  let promised: number | undefined;
  if (typeof promisedMinutes === "number" && promisedMinutes > 0) {
    promised = promisedMinutes;
    when = new Date(Date.now() + promisedMinutes * 60_000);
  } else if (typeof estimatedReadyAt === "string") {
    when = new Date(estimatedReadyAt);
    if (isNaN(when.getTime())) { res.status(400).json({ error: "Invalid estimatedReadyAt" }); return; }
  } else {
    res.status(400).json({ error: "Provide estimatedReadyAt (ISO) or promisedMinutes (number > 0)" });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }
  const [updated] = await db.update(ordersTable)
    .set({ estimatedReadyAt: when, etaAdjustedBySupervisor: true, ...(promised != null ? { promisedMinutes: promised } : {}) })
    .where(eq(ordersTable.id, orderId)).returning();
  emitUpdated(updated, "eta_adjusted");
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_ETA_ADJUSTED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { estimatedReadyAt: when.toISOString(), promisedMinutes: promised ?? null }, ipAddress: req.ip,
  });
  res.json(await buildOrderResponse(updated));
});

// POST /api/orders/:id/mark-ready — supervisor-only ready toggle.
router.post("/orders/:id/mark-ready", requireRole("supervisor", "admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }
  const now = new Date();
  const [updated] = await db.update(ordersTable)
    .set({ readyAt: now, status: "ready", fulfillmentStatus: "ready" })
    .where(eq(ordersTable.id, orderId)).returning();
  publishOrderEvent({
    type: "order.ready",
    orderId,
    customerId: updated.customerId,
    assignedCsrUserId: updated.assignedCsrUserId ?? null,
    readyAt: now.toISOString(),
  });
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_MARKED_READY",
    resourceType: "order", resourceId: String(orderId),
    metadata: {}, ipAddress: req.ip,
  });
  res.json(await buildOrderResponse(updated));
});

// POST /api/orders/:id/reassign — supervisor reassigns to a specific user
router.post("/orders/:id/reassign", requireRole("supervisor", "admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const { assignedCsrUserId } = req.body as { assignedCsrUserId?: number | null };
  if (assignedCsrUserId !== null && typeof assignedCsrUserId !== "number") {
    res.status(400).json({ error: "assignedCsrUserId must be a user id or null" });
    return;
  }
  // Capture the previous assignee BEFORE the swap so we can emit a
  // scoped clearance event to them after the new assignment publishes.
  const [priorRow] = await db.select({ a: ordersTable.assignedCsrUserId })
    .from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  const previousAssignedCsrUserId = priorRow?.a ?? null;
  let updated;
  try {
    updated = await reassignOrder(orderId, assignedCsrUserId);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  emitUpdated(updated, "reassigned");
  // CSR -> CSR (or CSR -> general) reassignment: the post-update event
  // above is scoped to the new assignee, so the previous CSR would keep
  // a stale alert. Emit a clearance event scoped to that previous CSR.
  if (previousAssignedCsrUserId !== null && previousAssignedCsrUserId !== updated.assignedCsrUserId) {
    publishOrderEvent({
      type: "order.updated",
      orderId: updated.id,
      customerId: updated.customerId,
      assignedCsrUserId: previousAssignedCsrUserId,
      fulfillmentStatus: updated.fulfillmentStatus ?? null,
      status: updated.status,
      estimatedReadyAt: updated.estimatedReadyAt ? updated.estimatedReadyAt.toISOString() : null,
      acceptedAt: updated.acceptedAt ? updated.acceptedAt.toISOString() : null,
      etaAdjustedBySupervisor: updated.etaAdjustedBySupervisor ?? false,
      routeSource: updated.routeSource ?? null,
      reason: "reassigned",
    });
  }
  // Spec: a reassignment must surface as a "new order" alert to the
  // newly-assigned CSR (or to the General Account queue when assignedCsrUserId
  // is null). Re-emit order.assigned so CsrAlertBanner enqueues for the
  // appropriate audience.
  let routedCustomerName = `customer ${updated.customerId}`;
  try {
    const [cust] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable).where(eq(usersTable.id, updated.customerId)).limit(1);
    if (cust) routedCustomerName = [cust.firstName, cust.lastName].filter(Boolean).join(" ") || cust.email || routedCustomerName;
  } catch { /* best-effort */ }
  const itemRows = await db.select({ qty: orderItemsTable.quantity })
    .from(orderItemsTable).where(eq(orderItemsTable.orderId, updated.id));
  publishOrderEvent({
    type: "order.assigned",
    orderId: updated.id,
    customerId: updated.customerId,
    assignedCsrUserId: updated.assignedCsrUserId ?? null,
    routeSource: "supervisor_override",
    customerName: routedCustomerName,
    total: Number(updated.total ?? 0),
    itemCount: itemRows.reduce((s, r) => s + (r.qty ?? 0), 0),
    routedAt: (updated.routedAt ?? new Date()).toISOString(),
    estimatedReadyAt: updated.estimatedReadyAt ? updated.estimatedReadyAt.toISOString() : null,
    promisedMinutes: updated.promisedMinutes ?? null,
  });
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "ORDER_REASSIGNED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { assignedCsrUserId }, ipAddress: req.ip,
  });
  res.json(await buildOrderResponse(updated));
});

// GET /api/orders/active-csrs — supervisor reassign dropdown source.
router.get("/orders/active-csrs", requireRole("supervisor", "admin"), async (_req, res): Promise<void> => {
  const active = await listActiveCsrs();
  if (active.length === 0) { res.json({ csrs: [] }); return; }
  const ids = active.map(a => a.userId);
  const users = await db.select({
    id: usersTable.id,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    role: usersTable.role,
  }).from(usersTable).where(sql`${usersTable.id} = ANY(${ids})`);
  const byId = new Map(users.map(u => [u.id, u]));
  res.json({
    csrs: active.map(a => {
      const u = byId.get(a.userId);
      return {
        userId: a.userId,
        shiftId: a.shiftId,
        name: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email : `User ${a.userId}`,
        role: u?.role ?? null,
      };
    }),
  });
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

  // Auto-deduct raw material inventory when order is delivered
  if (
    body.data.status === "delivered" &&
    order.status !== "delivered"
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

  emitUpdated(updated, "status_changed");

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

  const { fulfillmentStatus: rawFulfillment } = req.body as { fulfillmentStatus?: string };
  // Task #12 vocabulary — the only values the new contract accepts.
  // Legacy inputs are mapped to the closest spec value before persistence
  // so out-of-spec strings can never be written, but older clients keep
  // working for one rollout cycle.
  const LEGACY_MAP: Record<string, string> = {
    complete: "completed",
    handed_off: "completed",
    courier_arrived: "ready",
    ready_behind_gate: "ready",
  };
  const VALID = ["submitted", "accepted", "preparing", "ready", "completed", "cancelled"] as const;
  const fulfillmentStatus = rawFulfillment ? (LEGACY_MAP[rawFulfillment] ?? rawFulfillment) : undefined;
  if (!fulfillmentStatus || !(VALID as readonly string[]).includes(fulfillmentStatus)) {
    res.status(400).json({ error: `fulfillmentStatus must be one of: ${VALID.join(", ")}` }); return;
  }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }

  const update: Partial<typeof ordersTable.$inferInsert> = { fulfillmentStatus };
  if (fulfillmentStatus === "preparing") update.status = "processing";
  if (fulfillmentStatus === "ready") update.status = "ready";
  if (fulfillmentStatus === "completed") update.status = "completed";
  if (fulfillmentStatus === "cancelled") update.status = "cancelled";

  const [updated] = await db.update(ordersTable).set(update).where(eq(ordersTable.id, orderId)).returning();

  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "UPDATE_FULFILLMENT_STATUS",
    resourceType: "order", resourceId: String(orderId),
    metadata: { fulfillmentStatus }, ipAddress: req.ip,
  });

  // Emit realtime so customer hourglass / CSR queue / supervisor views
  // do not lag behind direct fulfillment-status mutations. Use
  // order.ready when the new state is ready, order.updated otherwise.
  if (fulfillmentStatus === "ready") {
    publishOrderEvent({
      type: "order.ready",
      orderId: updated.id,
      customerId: updated.customerId,
      assignedCsrUserId: updated.assignedCsrUserId ?? null,
      readyAt: new Date().toISOString(),
    });
  } else {
    emitUpdated(updated, "fulfillment_changed");
  }

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
