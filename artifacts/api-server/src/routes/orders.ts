import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, lt, isNotNull, notInArray, or, sql, inArray } from "drizzle-orm";
import {
  db,
  ordersTable,
  orderItemsTable,
  orderNotesTable,
  usersTable,
  notificationsTable,
  labTechShiftsTable,
  inventoryTemplatesTable,
  adminSettingsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
  csrBoxesTable,
  catalogItemsTable,
} from "@workspace/db";
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
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog, normalizeRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import {
  normalizeCheckoutCart,
  computeCheckoutTotals,
  buildMerchantPayloadLines,
  CheckoutMappingError,
  CartLineInput,
  type NormalizedCartLine,
} from "../lib/checkoutNormalizer";
import { z } from "zod";
import { logger } from "../lib/logger";
import { decideRouting, reassignOrder, listActiveCsrs, isShiftOrderRoutable } from "../lib/orderRouting";
import { publishOrderEvent, subscribe, getRecentEventsForClient } from "../lib/orderEvents";
import {
  createUberDeliveryQuote,
  getConfiguredPickupAddress,
  getUberPickupAction,
  hasUberDirectConfig,
  UberDirectApiError,
  UberDirectConfigError,
  type UberManifestItem,
} from "../lib/uberDirect";

const router: IRouter = Router();
class InsufficientInventoryError extends Error {
  constructor(public readonly catalogItemId: number) {
    super(`Insufficient inventory for catalog item ${catalogItemId}`);
    this.name = "InsufficientInventoryError";
  }
}


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
  requireRole("global_admin", "admin"),
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

const PreviewCartLineInput = z.object({
  catalogItemId: z.number().int().positive(),
  quantity: z.number().int().positive(),
}).strict();

const PreviewConversionBody = z.object({
  items: z.array(PreviewCartLineInput).min(1),
  confirmation: z.object({
    acceptedAllSalesFinal: z.literal(true),
    confirmedAt: z.string().datetime().optional(),
    legalDisclaimerText: z.string().min(1).max(1000),
  }),
}).strict();

function buildConversionPreview(lines: NormalizedCartLine[], confirmation: z.infer<typeof PreviewConversionBody>["confirmation"]) {
  const totals = computeCheckoutTotals(lines);
  return {
    confirmation: {
      acceptedAllSalesFinal: true,
      confirmedAt: confirmation.confirmedAt ?? new Date().toISOString(),
      legalDisclaimerText: confirmation.legalDisclaimerText,
    },
    cartSnapshot: lines.map(line => ({
      catalogItemId: line.catalog_item_id,
      internalName: line.catalog_display_name,
      merchantSku: line.merchant_sku,
      sourceType: line.source_type,
      quantity: line.quantity,
      unitPrice: line.unit_price,
      lineSubtotal: line.line_subtotal,
    })),
    pricingSnapshot: {
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      taxRate: totals.taxRate,
    },
    converted: {
      stage: "customer_facing_product_conversion",
      brandName: lines[0]?.merchant_brand_name ?? "Lucifer Cruz",
      headline: "Your order has been converted into a branded checkout experience.",
      zappyMessage: "I transformed the internal cart into customer-ready merchandise, checked the merchant mapping, and prepared payment options. Cash orders may qualify for exclusive discounts when enabled.",
      paymentMethods: [
        { id: "cash", label: "Cash", promoted: true, message: "Cash orders qualify for exclusive discounts." },
        { id: "cash_app", label: "Cash App", promoted: false },
        { id: "stripe", label: "Stripe card", promoted: false },
        { id: "venmo", label: "Venmo", promoted: false },
        { id: "gift_card", label: "Gift Card", promoted: false },
        { id: "manual", label: "Other/manual", promoted: false },
      ],
      items: lines.map(line => ({
        catalogItemId: line.catalog_item_id,
        displayName: line.display_name,
        customerSafeName: line.customer_safe_name,
        displayDescription: line.display_description,
        customerSafeDescription: line.customer_safe_description,
        displayCategory: line.display_category,
        displayImage: line.display_image,
        merchantBrandName: line.merchant_brand_name,
        marketingCopy: line.marketing_copy,
        upsellCopy: line.upsell_copy,
        promoBadges: line.promo_badges,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        lineSubtotal: line.line_subtotal,
      })),
    },
  };
}

const DeliveryQuoteCartLineInput = z.object({
  catalogItemId: z.number().int().positive(),
  quantity: z.number().int().positive(),
}).strict();

const DeliveryQuoteBody = z.object({
  items: z.array(DeliveryQuoteCartLineInput).min(1),
  dropoffAddress: z.string().min(8).max(1000),
}).strict();

function parseFirstPickupAddressFromSettings(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Array<{ address?: unknown }> | null;
    if (!Array.isArray(parsed)) return null;
    for (const location of parsed) {
      const address = typeof location.address === "string" ? location.address.trim() : "";
      if (address) return address;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveUberPickupAddress(): Promise<string | null> {
  const envPickupAddress = getConfiguredPickupAddress();
  if (envPickupAddress) return envPickupAddress;
  const [settings] = await db.select({ shiftLocationOptions: adminSettingsTable.shiftLocationOptions })
    .from(adminSettingsTable)
    .limit(1);
  return parseFirstPickupAddressFromSettings(settings?.shiftLocationOptions);
}

function buildUberManifestItems(lines: NormalizedCartLine[]): UberManifestItem[] {
  return lines.map(line => ({
    name: line.merchant_name || line.display_name || line.catalog_display_name,
    quantity: line.quantity,
    price: Math.max(0, Math.round(line.unit_price * 100)),
    size: "small",
    replacement_type: "contact_customer",
    sku: line.merchant_sku ?? line.woo_product_id ?? String(line.catalog_item_id),
  }));
}

function normalizeCheckoutTip(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    throw new Error("Tip amount must be between $0 and $1,000.");
  }
  return Math.round(n * 100) / 100;
}

// POST /api/orders/preview-conversion
// Mandatory pre-payment conversion stage. Zappy/customer clients call this
// after the final cart confirmation and before any payment UI appears.
router.post("/orders/preview-conversion", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = PreviewConversionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message, details: body.error.issues });
    return;
  }

  let normalizedLines: NormalizedCartLine[];
  try {
    normalizedLines = await normalizeCheckoutCart(body.data.items, undefined, false);
  } catch (normErr) {
    if (normErr instanceof CheckoutMappingError) {
      await writeAuditLog({
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: "ITEM_CONVERSION_FAILED",
        resourceType: "catalog_item",
        resourceId: String(normErr.catalogItemId),
        metadata: { stage: "preview_conversion", reason: normErr.reason, items: body.data.items },
        ipAddress: req.ip,
      });
      res.status(422).json({
        error: "Item not available for branded checkout conversion",
        catalogItemId: normErr.catalogItemId,
      });
      return;
    }
    res.status(400).json({ error: (normErr as Error)?.message ?? "Cart validation failed" });
    return;
  }

  const preview = buildConversionPreview(normalizedLines, body.data.confirmation);
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "ORDER_CONVERSION_PREVIEWED",
    resourceType: "order",
    metadata: {
      itemCount: normalizedLines.length,
      acceptedAllSalesFinal: true,
      confirmedAt: preview.confirmation.confirmedAt,
      total: preview.pricingSnapshot.total,
    },
    ipAddress: req.ip,
  });

  res.json(preview);
});

// POST /api/orders/delivery-quote
// Creates an Uber Direct quote for customers choosing courier delivery. This
// does not dispatch a courier; it returns quote details for checkout and order
// audit persistence. Dispatch can be added as a staff-only action later.
router.post("/orders/delivery-quote", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = DeliveryQuoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message, details: body.error.issues });
    return;
  }
  if (!hasUberDirectConfig()) {
    res.status(503).json({ error: "Uber Courier is not configured." });
    return;
  }

  let normalizedLines: NormalizedCartLine[];
  try {
    normalizedLines = await normalizeCheckoutCart(body.data.items);
  } catch (normErr) {
    if (normErr instanceof CheckoutMappingError) {
      res.status(422).json({
        error: "Item not available for Uber Courier delivery",
        catalogItemId: normErr.catalogItemId,
      });
      return;
    }
    res.status(400).json({ error: (normErr as Error)?.message ?? "Cart validation failed" });
    return;
  }

  const pickupAddress = await resolveUberPickupAddress();
  if (!pickupAddress) {
    res.status(503).json({ error: "Uber Courier pickup address is not configured." });
    return;
  }

  try {
    const manifestItems = buildUberManifestItems(normalizedLines);
    const quote = await createUberDeliveryQuote({
      pickupAddress,
      dropoffAddress: body.data.dropoffAddress,
      manifestItems,
      pickupAction: getUberPickupAction(),
    });

    await writeAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "UBER_DELIVERY_QUOTE_CREATED",
      resourceType: "order",
      metadata: {
        quoteId: quote.id,
        fee: quote.fee ?? null,
        currency: quote.currency_type ?? null,
        pickupAction: quote.pickup_action ?? getUberPickupAction(),
        itemCount: manifestItems.length,
      },
      ipAddress: req.ip,
    });

    res.json({
      provider: "uber_direct",
      quoteId: quote.id,
      fee: typeof quote.fee === "number" ? quote.fee / 100 : null,
      feeCents: quote.fee ?? null,
      currency: quote.currency_type ?? "USD",
      dropoffEta: quote.dropoff_eta ?? null,
      duration: quote.duration ?? null,
      pickupDuration: quote.pickup_duration ?? null,
      expires: quote.expires ?? null,
      pickupAction: quote.pickup_action ?? getUberPickupAction(),
      manifestItems,
    });
  } catch (err) {
    if (err instanceof UberDirectConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof UberDirectApiError) {
      res.status(err.status >= 400 && err.status < 500 ? 422 : 502).json({ error: err.message });
      return;
    }
    logger.warn({ err }, "Unexpected Uber Courier quote failure");
    res.status(502).json({ error: "Uber Courier quote failed." });
  }
});

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
    deliveryMethod: order.deliveryMethod ?? null,
    deliveryQuoteId: order.deliveryQuoteId ?? null,
    deliveryFee: order.deliveryFee == null ? null : parseFloat(order.deliveryFee as string),
    deliveryCurrency: order.deliveryCurrency ?? null,
    deliveryQuote: order.deliveryQuoteSnapshot ?? null,
    notes: order.notes,
    trackingUrl: order.trackingUrl ?? null,
    trackingSubmittedAt: order.trackingSubmittedAt ?? null,
    handoffChecklist: (order.handoffChecklist as Record<string, boolean> | null) ?? null,
    handoffCompletedAt: order.handoffCompletedAt ?? null,
    handoffCompletedByUserId: order.handoffCompletedByUserId ?? null,
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

async function notifyLowStockIfNeeded(tmpl: typeof inventoryTemplatesTable.$inferSelect, newStock: number): Promise<void> {
  const parLevel = tmpl.parLevel != null ? parseFloat(String(tmpl.parLevel)) : 0;
  if (!Number.isFinite(parLevel) || parLevel <= 0 || newStock > parLevel) return;

  const recipients = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      inArray(usersTable.role, ["global_admin", "admin"]),
      eq(usersTable.isActive, true),
    ));

  if (!recipients.length) return;
  await db.insert(notificationsTable).values(recipients.map(r => ({
    userId: r.id,
    type: "inventory_low_stock",
    title: "Low stock alert",
    message: `${tmpl.itemName} is at ${newStock.toFixed(2)} ${tmpl.unitType ?? ""} (par ${parLevel}).`,
    resourceType: "inventory_template",
    resourceId: tmpl.id,
  })));
}

// GET /api/orders
router.get("/orders", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  let rows = await db.select().from(ordersTable)
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.customerId, actor.id)))
    .orderBy(desc(ordersTable.createdAt));

  // /orders powers the left-nav customer order history and is always scoped
  // to the logged-in owner. Broader operational views live under
  // /shift-queue/orders and the admin-specific order endpoints.
  if (query.data.status) rows = rows.filter(o => o.status === query.data.status);
  if (query.data.customerId && query.data.customerId !== actor.id) rows = [];

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

  // Strict re-parse of cart lines: rejects any client-supplied unitPrice,
  // total, sku, merchantName, etc. Server is the single source of truth for
  // pricing — clients send only catalogItemId + quantity.
  const StrictItemsSchema = z.array(CartLineInput).min(1);
  const strictItems = StrictItemsSchema.safeParse(body.data.items);
  if (!strictItems.success) {
    res.status(400).json({
      error: "Cart line items must contain only catalogItemId and quantity",
      details: strictItems.error.issues,
    });
    return;
  }

  // Dual-brand normalization: converts every Alavont catalog line into a
  // Lucifer Cruz merchant line. Throws CheckoutMappingError (→ 422) when an
  // Alavont item has no LC mapping so a payment intent is NEVER created
  // against an unrouteable cart.
  let normalizedLines: NormalizedCartLine[];
  try {
    normalizedLines = await normalizeCheckoutCart(strictItems.data);
  } catch (normErr) {
    if (normErr instanceof CheckoutMappingError) {
      // Audit BEFORE returning so missing-mapping incidents are observable.
      await writeAuditLog({
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: "ITEM_CONVERSION_FAILED",
        resourceType: "catalog_item",
        resourceId: String(normErr.catalogItemId),
        metadata: { reason: normErr.reason, message: normErr.message, items: strictItems.data },
        ipAddress: req.ip,
      });
      res.status(422).json({
        error: "Item not available for purchase",
        catalogItemId: normErr.catalogItemId,
      });
      return;
    }
    res.status(400).json({ error: (normErr as Error)?.message ?? "Cart validation failed" });
    return;
  }

  // Server-side authoritative totals — any client-supplied numeric fields
  // were rejected above; subtotal/tax/total are rederived from DB prices.
  const totals = computeCheckoutTotals(normalizedLines);
  const subtotal = totals.subtotal;
  const tax = totals.tax;
  const merchandiseTotal = totals.total;
  const checkoutConfirmation = body.data.checkoutConfirmation ?? null;
  const deliveryQuote = body.data.deliveryQuote ?? null;
  const explicitDeliveryMethod = body.data.deliveryMethod ?? null;
  const isCsrDelivery = explicitDeliveryMethod === "csr_delivery";

  // CSR personal delivery fee: $5 flat + 3% of subtotal → goes to CSR as gratuity
  const csrDeliveryFee = isCsrDelivery ? Math.round((5 + 0.03 * subtotal) * 100) / 100 : 0;
  const deliveryFee = isCsrDelivery
    ? csrDeliveryFee
    : deliveryQuote?.fee != null ? Math.max(0, Math.round(Number(deliveryQuote.fee) * 100) / 100) : 0;
  let tipAmount: number;
  try {
    tipAmount = normalizeCheckoutTip(checkoutConfirmation?.tipAmount);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const finalTotal = Math.round((merchandiseTotal + deliveryFee + tipAmount) * 100) / 100;
  const finalConfirmationAt = checkoutConfirmation?.confirmedAt
    ? new Date(checkoutConfirmation.confirmedAt)
    : null;

  const houseTenantId = await getHouseTenantId();

  const normalizedCatalogIds = Array.from(new Set(normalizedLines.map(line => line.catalog_item_id)));
  const tenantCatalogRows = normalizedCatalogIds.length > 0
    ? await db
      .select({ id: catalogItemsTable.id })
      .from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, houseTenantId),
        inArray(catalogItemsTable.id, normalizedCatalogIds),
      ))
    : [];
  if (tenantCatalogRows.length !== normalizedCatalogIds.length) {
    res.status(404).json({ error: "One or more catalog items were not found for this tenant" });
    return;
  }

  // supervisor_manual_assignment; routes to assigned CSR + their active
  // shift, or to the General Account fallback queue).
  const routing = await decideRouting(houseTenantId);

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

  let targetLocationId: number | null = null;
  if (assignedShiftId) {
    const [activeShift] = await db
      .select({ boxAssignmentId: labTechShiftsTable.boxAssignmentId })
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.id, assignedShiftId))
      .limit(1);

    if (activeShift?.boxAssignmentId) {
      const [box] = await db
        .select({ id: csrBoxesTable.id })
        .from(csrBoxesTable)
        .where(and(
          eq(csrBoxesTable.tenantId, houseTenantId),
          eq(csrBoxesTable.slug, activeShift.boxAssignmentId),
        ))
        .limit(1);
      if (box) {
        const [loc] = await db
          .select({ id: inventoryLocationsTable.id })
          .from(inventoryLocationsTable)
          .where(and(
            eq(inventoryLocationsTable.tenantId, houseTenantId),
            eq(inventoryLocationsTable.csrBoxId, box.id),
          ))
          .limit(1);
        targetLocationId = loc?.id ?? null;
      }
    }
  }

  if (!targetLocationId) {
    const [storefrontLoc] = await db
      .select({ id: inventoryLocationsTable.id })
      .from(inventoryLocationsTable)
      .where(and(
        eq(inventoryLocationsTable.tenantId, houseTenantId),
        eq(inventoryLocationsTable.type, "storefront"),
      ))
      .limit(1);
    targetLocationId = storefrontLoc?.id ?? null;
  }

  if (!targetLocationId) {
    res.status(409).json({ error: "No inventory location available for this order" });
    return;
  }

  let order: typeof ordersTable.$inferSelect;
  try {
    order = await db.transaction(async (tx) => {
      const [createdOrder] = await tx.insert(ordersTable).values({
        tenantId: houseTenantId,
        customerId: actor.id,
        status: "pending",
        paymentStatus: "unpaid",
        paymentMethod: checkoutConfirmation?.paymentMethod ?? "cash",
        subtotal: String(subtotal.toFixed(2)),
        tax: String(tax.toFixed(2)),
        total: String(finalTotal.toFixed(2)),
        shippingAddress: body.data.shippingAddress ?? null,
        deliveryMethod: isCsrDelivery
          ? "csr_delivery"
          : (deliveryQuote?.provider ?? (body.data.shippingAddress ? "manual_delivery" : "pickup")),
        deliveryQuoteId: deliveryQuote?.quoteId ?? null,
        deliveryQuoteSnapshot: deliveryQuote ?? null,
        deliveryFee: deliveryFee > 0 ? String(deliveryFee.toFixed(2)) : null,
        deliveryCurrency: isCsrDelivery ? "usd" : (deliveryQuote?.currency ?? null),
        notes: body.data.notes ?? null,
        assignedTechId,
        assignedShiftId,
        assignedCsrUserId: routing.assignedCsrUserId,
        routeSource: routing.routeSource,
        routedTo: routing.routedTo,
        routingStrategy: routing.rule,
        routingStatus: routing.routingStatus,
        routingMessage: routing.routingMessage,
        routedAt: now,
        promisedMinutes: routing.promisedMinutes,
        estimatedReadyAt: routing.estimatedReadyAt,
        fulfillmentStatus: "submitted",
        finalConfirmationAt,
        legalDisclaimerAccepted: checkoutConfirmation?.acceptedAllSalesFinal === true,
        legalDisclaimerText: checkoutConfirmation?.legalDisclaimerText ?? null,
        selectedPaymentMethod: checkoutConfirmation?.paymentMethod ?? "cash",
      }).returning();

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
      const checkoutConversionSnapshot = buildConversionPreview(normalizedLines, {
        acceptedAllSalesFinal: true,
        confirmedAt: checkoutConfirmation?.confirmedAt ?? new Date().toISOString(),
        legalDisclaimerText: checkoutConfirmation?.legalDisclaimerText ?? "Order confirmed before payment.",
      });
      const checkoutSnapshotWithTip = {
        ...checkoutConversionSnapshot,
        tip: {
          amount: tipAmount,
          percent: checkoutConfirmation?.tipPercent ?? null,
          recipient: "csr",
        },
        pricingSnapshot: {
          ...checkoutConversionSnapshot.pricingSnapshot,
          deliveryFee,
          tipAmount,
          totalBeforeTip: merchandiseTotal + deliveryFee,
          total: finalTotal,
        },
      };

      await tx.update(ordersTable).set({
        alavontCartSnapshot,
        luciferCheckoutSnapshot,
        checkoutConversionSnapshot: checkoutSnapshotWithTip,
      }).where(eq(ordersTable.id, createdOrder.id));

      for (const line of normalizedLines) {
        await tx.insert(orderItemsTable).values({
          orderId: createdOrder.id,
          catalogItemId: line.catalog_item_id,
          catalogItemName: line.catalog_display_name,
          quantity: line.quantity,
          unitPrice: String(line.unit_price.toFixed(2)),
          totalPrice: String((line.unit_price * line.quantity).toFixed(2)),
          alavontName: line.receipt_alavont_name,
          luciferCruzName: line.merchant_name,
          receiptName: line.receipt_name ?? line.merchant_name,
          labelName: line.label_name ?? line.merchant_name,
          labName: line.lab_name ?? line.receipt_alavont_name,
          wooProductId: line.woo_product_id ?? null,
          wooVariationId: line.woo_variation_id ?? null,
        });

        const decremented = await tx
          .update(inventoryBalancesTable)
          .set({
            quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(line.quantity)}`,
          })
          .where(and(
            eq(inventoryBalancesTable.tenantId, houseTenantId),
            eq(inventoryBalancesTable.productId, line.catalog_item_id),
            eq(inventoryBalancesTable.locationId, targetLocationId),
            sql`${inventoryBalancesTable.quantityOnHand} >= ${String(line.quantity)}`,
          ))
          .returning({ id: inventoryBalancesTable.id });

        if (decremented.length !== 1) {
          throw new InsufficientInventoryError(line.catalog_item_id);
        }

        await tx.execute(sql`
            UPDATE catalog_items
            SET
              stock_quantity = COALESCE((
                SELECT SUM(quantity_on_hand)
                FROM inventory_balances
                WHERE tenant_id = ${houseTenantId}
                  AND product_id = ${line.catalog_item_id}
              ), 0),
              inventory_amount = COALESCE((
                SELECT SUM(quantity_on_hand)
                FROM inventory_balances
                WHERE tenant_id = ${houseTenantId}
                  AND product_id = ${line.catalog_item_id}
              ), 0)
            WHERE tenant_id = ${houseTenantId}
              AND id = ${line.catalog_item_id}
          `);
      }

      return createdOrder;
    });
  } catch (err) {
    if (err instanceof InsufficientInventoryError) {
      res.status(409).json({ error: "Insufficient inventory", catalogItemId: err.catalogItemId });
      return;
    }
    throw err;
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
    metadata: {
      total: finalTotal,
      itemCount: normalizedLines.length,
      routeSource: routing.routeSource,
      assignedCsrUserId: routing.assignedCsrUserId,
      finalConfirmationAt: finalConfirmationAt?.toISOString() ?? null,
      legalDisclaimerAccepted: checkoutConfirmation?.acceptedAllSalesFinal === true,
      selectedPaymentMethod: checkoutConfirmation?.paymentMethod ?? "cash",
      deliveryMethod: isCsrDelivery
        ? "csr_delivery"
        : (deliveryQuote?.provider ?? (body.data.shippingAddress ? "manual_delivery" : "pickup")),
      deliveryQuoteId: deliveryQuote?.quoteId ?? null,
      deliveryFee,
      tipAmount,
      tipPercent: checkoutConfirmation?.tipPercent ?? null,
    },
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

  // CSR delivery earnings: atomically increment shift csrDeliveryEarnings (fire-and-forget)
  if (isCsrDelivery && assignedShiftId && csrDeliveryFee > 0) {
    db.update(labTechShiftsTable)
      .set({ csrDeliveryEarnings: sql`coalesce(${labTechShiftsTable.csrDeliveryEarnings}, 0) + ${String(csrDeliveryFee.toFixed(2))}` })
      .where(eq(labTechShiftsTable.id, assignedShiftId))
      .catch(err => logger.warn({ err, shiftId: assignedShiftId, csrDeliveryFee }, "Failed to update csrDeliveryEarnings"));
  }

  const customerName = `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || actor.email || "Customer";

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
      fulfillmentType: body.data.shippingAddress ? "delivery" : "pickup",
      shippingAddress: body.data.shippingAddress ?? null,
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
    total: finalTotal,
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
router.post("/orders/:id/accept", requireRole("csr"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId))).limit(1);
  if (!order) { res.status(404).json({ error: "Not found" }); return; }

  const [shift] = await db.select().from(labTechShiftsTable).where(and(
    eq(labTechShiftsTable.tenantId, tenantId),
    eq(labTechShiftsTable.techId, actor.id),
    eq(labTechShiftsTable.status, "active"),
  )).limit(1);
  if (!shift || !isShiftOrderRoutable(shift)) {
    res.status(403).json({ error: "CSR must have an active ready shift before claiming orders" });
    return;
  }

  // CSRs may only accept tenant-local orders assigned to them/their ready
  // active shift, or sitting in the General Account fallback queue.
  if (normalizeRole(actor.role) === "csr") {
    if (order.assignedCsrUserId != null && order.assignedCsrUserId !== actor.id) {
      res.status(403).json({ error: "Order is assigned to another rep" });
      return;
    }
    if (order.assignedShiftId != null && order.assignedShiftId !== shift.id) {
      res.status(403).json({ error: "Order is assigned to another shift" });
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
      assignedShiftId: order.assignedShiftId ?? shift.id,
    })
    .where(and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.tenantId, tenantId),
      sql`${ordersTable.acceptedAt} is null`,
      eq(ordersTable.fulfillmentStatus, "submitted"),
      order.assignedCsrUserId == null ? sql`${ordersTable.assignedCsrUserId} is null` : eq(ordersTable.assignedCsrUserId, actor.id),
      order.assignedShiftId == null ? sql`${ordersTable.assignedShiftId} is null` : eq(ordersTable.assignedShiftId, shift.id),
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
router.patch("/orders/:id/eta", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
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
router.post("/orders/:id/mark-ready", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
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
router.post("/orders/:id/reassign", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
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
router.get("/orders/active-csrs", requireRole("global_admin", "admin", "supervisor"), async (_req, res): Promise<void> => {
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
router.get("/orders/summary", requireRole("global_admin", "admin"), async (_req, res): Promise<void> => {
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
router.get("/orders/recent", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
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
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.id, params.data.id), eq(ordersTable.tenantId, tenantId))).limit(1);
  if (!order) {
    res.status(404).json({ error: "This order could not be found or you do not have access to it." });
    return;
  }
  const role = normalizeRole(actor.role);
  if (role === "user" && order.customerId !== actor.id) {
    res.status(404).json({ error: "This order could not be found or you do not have access to it." });
    return;
  }
  const orderObj = await buildOrderResponse(order);
  res.json(GetOrderResponse.parse(orderObj));
});

const LifecycleBody = z.object({
  status: z.enum(["completed", "cancelled", "archived", "voided"]),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();

type DbActor = NonNullable<Request["dbUser"]>;
async function actorCanOperateOrder(actor: DbActor, order: typeof ordersTable.$inferSelect, nextStatus: string) {
  const role = normalizeRole(actor.role);
  if (role === "user") return false;
  if (role === "csr") {
    if (!["completed", "cancelled"].includes(nextStatus)) return false;
    const [shift] = await db.select().from(labTechShiftsTable).where(and(
      eq(labTechShiftsTable.techId, actor.id),
      eq(labTechShiftsTable.status, "active"),
      eq(labTechShiftsTable.id, order.assignedShiftId ?? -1),
    )).limit(1);
    return !!shift && order.assignedCsrUserId === actor.id;
  }
  return ["supervisor", "admin", "global_admin"].includes(role);
}

async function transitionOrder(req: Request, res: Response, forcedStatus?: "completed" | "cancelled" | "archived" | "voided") {
  const actor = req.dbUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  const parsed = LifecycleBody.safeParse({ ...req.body, status: forcedStatus ?? req.body?.status });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status, reason } = parsed.data;
  if (["cancelled", "archived", "voided"].includes(status) && !reason) {
    res.status(400).json({ error: "Reason is required" });
    return;
  }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.id, id), eq(ordersTable.tenantId, tenantId))).limit(1);
  if (!order) {
    res.status(404).json({ error: "This order could not be found or you do not have access to it." });
    return;
  }
  const role = normalizeRole(actor.role);
  if (status === "voided" && !["admin", "global_admin"].includes(role)) {
    res.status(403).json({ error: "Void requires admin permission" });
    return;
  }
  if (!await actorCanOperateOrder(actor, order, status)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const prior = order.status;
  if (prior === "completed" && status !== "archived") {
    res.status(409).json({ error: "Completed orders cannot be moved back to active states" });
    return;
  }
  if (prior === "voided") {
    res.status(409).json({ error: "Voided orders cannot be reactivated" });
    return;
  }
  if (prior === "archived" && status !== "voided") {
    res.status(409).json({ error: "Archived orders require an explicit restore endpoint before active transitions" });
    return;
  }
  const now = new Date();
  const stamps: Partial<typeof ordersTable.$inferInsert> =
    status === "completed" ? { completedAt: now, completedByUserId: actor.id, fulfillmentStatus: "completed" } :
    status === "cancelled" ? { cancelledAt: now, cancelledByUserId: actor.id, fulfillmentStatus: "cancelled" } :
    status === "archived" ? { archivedAt: now, archivedByUserId: actor.id } :
    { voidedAt: now, voidedByUserId: actor.id };
  const [updated] = await db.update(ordersTable).set({ status, ...stamps }).where(eq(ordersTable.id, id)).returning();
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "ORDER_STATUS_CHANGED",
    resourceType: "order",
    resourceId: String(id),
    metadata: { priorStatus: prior, newStatus: status, reason: reason ?? null },
    ipAddress: req.ip,
  });
  res.json(await buildOrderResponse(updated));
}

router.patch("/orders/:id/status", (req, res) => { void transitionOrder(req, res); });
router.post("/orders/:id/complete", (req, res) => { void transitionOrder(req, res, "completed"); });
router.post("/orders/:id/cancel", (req, res) => { void transitionOrder(req, res, "cancelled"); });
router.post("/orders/:id/archive", (req, res) => { void transitionOrder(req, res, "archived"); });
router.post("/orders/:id/void", (req, res) => { void transitionOrder(req, res, "voided"); });

// PATCH /api/orders/:id
router.patch("/orders/:id", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
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
          await notifyLowStockIfNeeded(tmpl, newStock);
        }
      }
    } catch { /* non-critical */ }
  }

  // In-app notification to customer
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
router.patch("/orders/:id/tracking", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = parseInt(raw, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const { trackingUrl } = req.body as { trackingUrl?: string };
  if (trackingUrl) {
    const parsedTracking = SubmitTrackingLinkBody.safeParse({ trackingUrl });
    if (!parsedTracking.success) {
      res.status(400).json({ error: parsedTracking.error.issues[0]?.message ?? "Invalid tracking link" });
      return;
    }
  }
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

  res.json({ trackingUrl: updated.trackingUrl });
});

// POST /api/orders/:id/fulfillment — set fulfillment status (staff/admin)
router.post("/orders/:id/fulfillment", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
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

  const role = normalizeRole(actor.role);
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  if (order.tenantId !== tenantId) { res.status(404).json({ error: "Not found" }); return; }
  if (role === "csr") {
    const [shift] = await db.select().from(labTechShiftsTable).where(and(
      eq(labTechShiftsTable.tenantId, tenantId),
      eq(labTechShiftsTable.techId, actor.id),
      eq(labTechShiftsTable.status, "active"),
      eq(labTechShiftsTable.id, order.assignedShiftId ?? -1),
    )).limit(1);
    if (!shift || !isShiftOrderRoutable(shift) || order.assignedCsrUserId !== actor.id) {
      res.status(403).json({ error: "CSR must have the assigned active ready shift to update fulfillment" }); return;
    }
  }
  const allowed: Record<string, string[]> = { submitted: ["accepted"], accepted: ["preparing"], preparing: ["ready", "cancelled"], ready: ["completed", "cancelled"], completed: [], cancelled: [] };
  const priorFulfillment = order.fulfillmentStatus ?? "submitted";
  if (!((allowed[priorFulfillment] ?? []).includes(fulfillmentStatus)) && fulfillmentStatus !== priorFulfillment) {
    res.status(409).json({ error: `Illegal fulfillment transition: ${priorFulfillment} -> ${fulfillmentStatus}` }); return;
  }

  const update: Partial<typeof ordersTable.$inferInsert> = { fulfillmentStatus };
  if (fulfillmentStatus === "preparing") update.status = "processing";
  if (fulfillmentStatus === "ready") update.status = "ready";
  if (fulfillmentStatus === "completed") update.status = "completed";
  if (fulfillmentStatus === "cancelled") update.status = "cancelled";

  const [updated] = await db.update(ordersTable).set(update).where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId))).returning();

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
router.post("/orders/:id/purge", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
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

// ── Delivery tracking (customer-booked Uber) ────────────────────────────────

const ALLOWED_UBER_DOMAINS = ["uber.com", "m.uber.com", "trip.uber.com"];
function isAllowedUberUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_UBER_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

const SubmitTrackingLinkBody = z.object({
  trackingUrl: z.string().min(1).max(2048).refine(isAllowedUberUrl, {
    message: "Only https:// Uber tracking links (uber.com, trip.uber.com) are allowed",
  }),
});

const HandoffChecklistBody = z.object({
  driverMatched: z.boolean().optional(),
  vehicleMatched: z.boolean().optional(),
  plateMatched: z.boolean().optional(),
  sealedDiscreet: z.boolean().optional(),
  handedToCourier: z.boolean().optional(),
});

// POST /api/orders/:id/delivery/tracking-link — customer submits Uber trip-share link
router.post("/orders/:id/delivery/tracking-link", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const body = SubmitTrackingLinkBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid body" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  const isStaff = ["global_admin", "admin", "supervisor", "csr"].includes(normalizeRole(actor.role));
  if (!isStaff && order.customerId !== actor.id) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!order.deliveryMethod || order.deliveryMethod === "pickup") {
    res.status(422).json({ error: "Order is not a delivery order" }); return;
  }
  const [updated] = await db.update(ordersTable)
    .set({ trackingUrl: body.data.trackingUrl, trackingSubmittedAt: new Date() })
    .where(eq(ordersTable.id, orderId))
    .returning();
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "DELIVERY_TRACKING_LINK_SUBMITTED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { trackingUrl: body.data.trackingUrl }, ipAddress: req.ip,
  });
  res.json({ trackingUrl: updated.trackingUrl, trackingSubmittedAt: updated.trackingSubmittedAt });
});

// PATCH /api/orders/:id/delivery/handoff-checklist — CSR updates courier handoff checklist
router.patch("/orders/:id/delivery/handoff-checklist", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const body = HandoffChecklistBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid body" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  const existing = (order.handoffChecklist as Record<string, boolean> | null) ?? {};
  const merged = { ...existing, ...body.data };
  const [updated] = await db.update(ordersTable)
    .set({ handoffChecklist: merged })
    .where(eq(ordersTable.id, orderId))
    .returning();
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "DELIVERY_HANDOFF_CHECKLIST_UPDATED",
    resourceType: "order", resourceId: String(orderId),
    metadata: { checklist: merged }, ipAddress: req.ip,
  });
  res.json({ handoffChecklist: updated.handoffChecklist });
});

// POST /api/orders/:id/delivery/handoff-complete — CSR marks courier handoff complete
router.post("/orders/:id/delivery/handoff-complete", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = parseInt(req.params.id as string, 10);
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.handoffCompletedAt) { res.status(409).json({ error: "Handoff already completed" }); return; }
  const now = new Date();
  const [updated] = await db.update(ordersTable)
    .set({ handoffCompletedAt: now, handoffCompletedByUserId: actor.id })
    .where(eq(ordersTable.id, orderId))
    .returning();
  await writeAuditLog({
    actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    action: "DELIVERY_HANDOFF_COMPLETE",
    resourceType: "order", resourceId: String(orderId),
    metadata: { handoffCompletedAt: now.toISOString() }, ipAddress: req.ip,
  });
  res.json({ handoffCompletedAt: updated.handoffCompletedAt, handoffCompletedByUserId: updated.handoffCompletedByUserId });
});

export default router;
