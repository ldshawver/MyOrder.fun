import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db, ordersTable, orderItemsTable, userCreditsTable, labTechShiftsTable, csrBoxesTable, inventoryLocationsTable, inventoryBalancesTable } from "@workspace/db";
import {
  TokenizePaymentBody,
  TokenizePaymentResponse,
  ConfirmPaymentParams,
  ConfirmPaymentBody,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  normalizeCheckoutCart,
  computeCheckoutTotals,
  CheckoutMappingError,
  type NormalizedCartLine,
} from "../lib/checkoutNormalizer";
import { buildStripeIntentPayload, payloadContainsAlavontLeak } from "../lib/stripePayload";
import { requireCurrentCustomerDisclaimerAcceptance } from "../lib/customerDisclaimerEnforcement";
import { requireOrderHasVerifiedCheckoutConversion, sendCheckoutConversionRequired, CheckoutConversionRequiredError } from "../lib/checkoutConversionGate";
import { buildSafeMerchantPayloadLines } from "../lib/merchantPayloadValidator";
import { sellableInventoryBalancePredicate } from "../lib/inventoryBalances";
import { sellableBalanceWhere } from "../lib/inventoryHealth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);
let creditSchemaEnsured = false;
class PaymentInventoryError extends Error {
  constructor(public readonly catalogItemId: number) {
    super(`Insufficient inventory for catalog item ${catalogItemId}`);
    this.name = "PaymentInventoryError";
  }
}

async function deductPaidOrderInventory(order: typeof ordersTable.$inferSelect): Promise<void> {
  const method = String(order.selectedPaymentMethod ?? order.paymentMethod ?? "").toLowerCase();
  if (method === "cash") return;
  if (!order.assignedShiftId || order.routeSource !== "active_csr") return;
  const [shift] = await db.select({ boxAssignmentId: labTechShiftsTable.boxAssignmentId }).from(labTechShiftsTable).where(eq(labTechShiftsTable.id, order.assignedShiftId)).limit(1);
  if (!shift?.boxAssignmentId) return;
  const [box] = await db.select({ id: csrBoxesTable.id }).from(csrBoxesTable).where(and(eq(csrBoxesTable.tenantId, order.tenantId), eq(csrBoxesTable.slug, shift.boxAssignmentId))).limit(1);
  if (!box) return;
  const [loc] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, order.tenantId), eq(inventoryLocationsTable.csrBoxId, box.id))).limit(1);
  if (!loc) return;
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));

  await db.transaction(async (tx) => {
    for (const item of items) {
      if (!item.catalogItemId) continue;
      const decremented = await tx.update(inventoryBalancesTable)
        .set({ quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(item.quantity)}` })
        .where(and(
          sellableInventoryBalancePredicate(order.tenantId),
          eq(inventoryBalancesTable.productId, item.catalogItemId),
          eq(inventoryBalancesTable.locationId, loc.id),
          sellableBalanceWhere(),
          sql`${inventoryBalancesTable.quantityOnHand} >= ${String(item.quantity)}`,
        ))
        .returning({ id: inventoryBalancesTable.id });
      if (decremented.length !== 1) throw new PaymentInventoryError(item.catalogItemId);
      await tx.execute(sql`
        UPDATE catalog_items
        SET stock_quantity = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${item.catalogItemId}), 0),
            inventory_amount = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${item.catalogItemId}), 0)
        WHERE tenant_id = ${order.tenantId} AND id = ${item.catalogItemId}
      `);
    }
  });
}


async function ensureCreditSchema(): Promise<void> {
  if (creditSchemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_credits" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "user_id" integer NOT NULL REFERENCES "users"("id"),
      "amount" numeric(10, 2) NOT NULL,
      "reason" text,
      "source" text NOT NULL DEFAULT 'admin_adjustment',
      "created_by" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  creditSchemaEnsured = true;
}

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function getCreditBalance(userId: number): Promise<number> {
  await ensureCreditSchema();
  const entries = await db.select().from(userCreditsTable).where(eq(userCreditsTable.userId, userId));
  return entries.reduce((sum, entry) => sum + money(entry.amount), 0);
}

// Dispatches WooCommerce-managed line items to WooCommerce (CJ Dropshipping sync)
// after payment is confirmed. Fire-and-forget — errors logged, never block response.
async function dispatchWooItemsAfterPayment(orderId: number): Promise<void> {
  try {
    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));

    const wooItems = items.filter(i => !!i.wooProductId);
    if (wooItems.length === 0) return;

    const { createWooOrder } = await import("../lib/wooClient");
    await createWooOrder({
      orderId,
      lines: wooItems.map(i => ({
        product_id: i.wooProductId!,
        variation_id: i.wooVariationId ?? undefined,
        name: i.luciferCruzName ?? i.catalogItemName,
        quantity: i.quantity,
        unit_price: parseFloat(i.unitPrice as string),
      })),
    });
  } catch (wooErr) {
    logger.warn({ wooErr, orderId }, "WooCommerce order dispatch failed after payment (non-critical)");
  }
}

function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
}

// POST /api/payments/tokenize
// Creates a Stripe PaymentIntent and returns the client secret so the
// browser can use Stripe Elements to collect card details.
// Raw card numbers NEVER touch our server.
router.post("/payments/tokenize", requireCurrentCustomerDisclaimerAcceptance("payments.tokenize"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = TokenizePaymentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, body.data.orderId))
    .limit(1);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.customerId !== actor.id && actor.role === "user") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try { await requireOrderHasVerifiedCheckoutConversion(order.id); } catch (err) { if (err instanceof CheckoutConversionRequiredError) { sendCheckoutConversionRequired(res); return; } throw err; }

  // Re-normalize cart from order items so the LC-only Stripe payload is built
  // from the SAME conversion path used at /orders. If the conversion fails
  // here (e.g. an item lost its mapping after order creation), the spec'd 422
  // is returned with the offending catalogItemId — Stripe is never called.
  let normalizedLines: NormalizedCartLine[] = [];
  // Authoritative server-side amount. Default is the persisted order.total
  // (which itself was server-recomputed by /orders); when normalized lines are
  // available we re-derive the total from them via computeCheckoutTotals(),
  // so a tampered or stale order row alone cannot mis-charge a customer.
  let serverAmount = parseFloat(order.total as string);
  const orderItems = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const cartLines = orderItems
    .filter(i => i.catalogItemId != null)
    .map(i => ({ catalogItemId: i.catalogItemId as number, quantity: i.quantity }));
  if (cartLines.length > 0) {
    try {
      normalizedLines = await normalizeCheckoutCart(cartLines);
    } catch (normalizeErr) {
      if (normalizeErr instanceof CheckoutMappingError) {
        await writeAuditLog({
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: "ITEM_CONVERSION_FAILED",
          resourceType: "catalog_item",
          resourceId: String(normalizeErr.catalogItemId),
          metadata: { stage: "tokenize", reason: normalizeErr.reason, orderId: order.id },
          ipAddress: req.ip,
        });
        res.status(422).json({
          error: "Item not available for purchase",
          catalogItemId: normalizeErr.catalogItemId,
        });
        return;
      }
      logger.error({ normalizeErr, orderId: order.id }, "Merchant routing validation failed — blocking payment tokenize");
      res.status(422).json({ error: "Merchant routing validation failed. Contact support." });
      return;
    }
    // Server-derived total. Any client-supplied `amount` in the request body
    // is IGNORED — pricing is recomputed from the normalized lines + tax rule.
    serverAmount = computeCheckoutTotals(normalizedLines).total;
    if (typeof body.data.amount === "number" && Math.abs(body.data.amount - serverAmount) > 0.01) {
      logger.warn(
        { orderId: order.id, clientAmount: body.data.amount, serverAmount, actorId: actor.id },
        "TOKENIZE_AMOUNT_MISMATCH: client-supplied amount differs from server total — using server value"
      );
    }
    logger.info(
      { orderId: order.id, merchantLines: buildSafeMerchantPayloadLines(normalizedLines), actorId: actor.id, serverAmount },
      "MERCHANT_PAYLOAD_AUDIT: Stripe tokenize — LC names for processor (no Alavont names)"
    );
  }

  // Build the Stripe-bound payload once, in one place. Every field that
  // crosses the Stripe boundary (description, metadata, statement_descriptor,
  // amount) is derived ONLY from server-trusted state — the client `amount`
  // is never forwarded to Stripe.
  const stripePayload = buildStripeIntentPayload({
    orderId: order.id,
    amount: serverAmount,
    currency: body.data.currency ?? "usd",
    lines: normalizedLines,
  });

  // Defense-in-depth: assert no Alavont string leaked into the Stripe payload.
  const leakCheck = payloadContainsAlavontLeak(stripePayload, normalizedLines);
  if (leakCheck.leaked) {
    logger.error(
      { orderId: order.id, offenders: leakCheck.offenders },
      "STRIPE_PAYLOAD_LEAK: Alavont strings detected in Stripe payload — blocking tokenize"
    );
    res.status(500).json({ error: "Payment processor payload validation failed." });
    return;
  }


  const stripe = getStripeClient();

  // Sandbox mode — Stripe keys not configured
  if (!stripe) {
    const mockPaymentIntentId = `pi_sandbox_${Date.now()}`;
    const mockClientSecret = `${mockPaymentIntentId}_secret_sandbox`;
    await db
      .update(ordersTable)
      .set({ paymentToken: mockClientSecret, paymentIntentId: mockPaymentIntentId })
      .where(eq(ordersTable.id, order.id));

    res.json(
      TokenizePaymentResponse.parse({
        clientSecret: mockClientSecret,
        paymentIntentId: mockPaymentIntentId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "pk_test_sandbox",
      })
    );
    return;
  }

  // Real Stripe — payload assembled by buildStripeIntentPayload() above
  try {
    const intent = await stripe.paymentIntents.create({
      amount: stripePayload.amount,
      currency: stripePayload.currency,
      description: stripePayload.description,
      statement_descriptor_suffix: stripePayload.statement_descriptor_suffix,
      metadata: stripePayload.metadata,
    });

    await db
      .update(ordersTable)
      .set({
        paymentToken: intent.client_secret,
        paymentIntentId: intent.id,
        paymentStatus: "pending",
      })
      .where(eq(ordersTable.id, order.id));

    res.json(
      TokenizePaymentResponse.parse({
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
      })
    );
  } catch (err) {
    logger.error({ err }, "Stripe payment intent creation failed");
    res.status(500).json({ error: "Payment processing error" });
  }
});

// POST /api/payments/:orderId/apply-credit
// Applies customer-selected account credit before external payment. Credit can
// partially reduce the payable total or fully pay the order.
router.post("/payments/:orderId/apply-credit", requireCurrentCustomerDisclaimerAcceptance("payments.apply_credit"), async (req, res): Promise<void> => {
  await ensureCreditSchema();
  const actor = req.dbUser!;
  const rawId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
  const orderId = parseInt(rawId, 10);
  const requestedAmount = Number(req.body?.amount);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.customerId !== actor.id && actor.role === "user") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try { await requireOrderHasVerifiedCheckoutConversion(order.id); } catch (err) { if (err instanceof CheckoutConversionRequiredError) { sendCheckoutConversionRequired(res); return; } throw err; }
  if (order.paymentStatus === "paid") {
    res.status(409).json({ error: "Order is already paid" });
    return;
  }

  const balance = await getCreditBalance(order.customerId);
  if (balance <= 0) {
    res.status(400).json({ error: "No credit balance available" });
    return;
  }

  const currentTotal = money(order.total);
  const applied = Math.min(requestedAmount, balance, currentTotal);
  if (applied <= 0) {
    res.status(400).json({ error: "No payable amount remains" });
    return;
  }
  const remainingTotal = Math.max(0, Number((currentTotal - applied).toFixed(2)));

  await db.insert(userCreditsTable).values({
    tenantId: order.tenantId,
    userId: order.customerId,
    amount: (-applied).toFixed(2),
    reason: `Applied to order #${order.id}`,
    source: "order_credit_application",
    createdBy: actor.id,
  });

  const [updated] = await db.update(ordersTable)
    .set({
      total: remainingTotal.toFixed(2),
      paymentMethod: remainingTotal === 0 ? "credit" : order.paymentMethod,
      selectedPaymentMethod: remainingTotal === 0 ? "credit" : order.selectedPaymentMethod,
      paymentStatus: remainingTotal === 0 ? "paid" : order.paymentStatus,
      status: remainingTotal === 0 ? "confirmed" : order.status,
      paymentToken: remainingTotal === 0 ? `credit_${Date.now()}` : order.paymentToken,
    })
    .where(eq(ordersTable.id, order.id))
    .returning();

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "APPLY_USER_CREDIT",
    tenantId: order.tenantId,
    resourceType: "order",
    resourceId: String(order.id),
    metadata: {
      applied,
      previousTotal: currentTotal,
      remainingTotal,
      previousBalance: balance,
      remainingBalance: Number((balance - applied).toFixed(2)),
    },
    ipAddress: req.ip,
  });

  if (remainingTotal === 0) {
    void dispatchWooItemsAfterPayment(updated.id);
  }

  res.json({
    orderId: updated.id,
    applied,
    remainingTotal,
    remainingBalance: Number((balance - applied).toFixed(2)),
    paymentStatus: updated.paymentStatus,
  });
});

// POST /api/payments/:orderId/confirm
// Verifies the PaymentIntent succeeded via Stripe, then marks the order as paid.
router.post("/payments/:orderId/confirm", requireCurrentCustomerDisclaimerAcceptance("payments.confirm"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const rawId = Array.isArray(req.params.orderId)
    ? req.params.orderId[0]
    : req.params.orderId;
  const params = ConfirmPaymentParams.safeParse({ orderId: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ConfirmPaymentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, params.data.orderId))
    .limit(1);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.customerId !== actor.id && actor.role === "user") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try { await requireOrderHasVerifiedCheckoutConversion(order.id); } catch (err) { if (err instanceof CheckoutConversionRequiredError) { sendCheckoutConversionRequired(res); return; } throw err; }

  const stripe = getStripeClient();
  const isSandbox = !stripe || body.data.paymentIntentId.includes("sandbox");

  // Sandbox mode — auto-confirm without calling Stripe
  if (isSandbox) {
    if (order.paymentStatus === "paid") {
      res.json({ id: order.id, tenantId: order.tenantId, customerId: order.customerId, status: order.status, paymentStatus: order.paymentStatus });
      return;
    }
    try {
      await deductPaidOrderInventory(order);
    } catch (err) {
      if (err instanceof PaymentInventoryError) {
        res.status(409).json({ error: "Insufficient inventory", catalogItemId: err.catalogItemId });
        return;
      }
      throw err;
    }

    const [updated] = await db
      .update(ordersTable)
      .set({ paymentStatus: "paid", status: "confirmed" })
      .where(eq(ordersTable.id, order.id))
      .returning();

    await writeAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "PAYMENT_CONFIRMED",
      tenantId: order.tenantId,
      resourceType: "order",
      resourceId: String(order.id),
      metadata: { paymentIntentId: body.data.paymentIntentId, sandbox: true },
      ipAddress: req.ip,
    });

    // Dispatch woo-managed items AFTER payment is confirmed (fire-and-forget)
    void dispatchWooItemsAfterPayment(updated.id);

    const { usersTable } = await import("@workspace/db");
    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, updated.id));
    const [c] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, updated.customerId))
      .limit(1);

    res.json({
      id: updated.id,
      tenantId: updated.tenantId,
      customerId: updated.customerId,
      customerName: c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() : "",
      customerEmail: c?.email ?? "",
      status: updated.status,
      paymentStatus: updated.paymentStatus,
      subtotal: parseFloat(updated.subtotal as string),
      tax: parseFloat((updated.tax as string) ?? "0"),
      total: parseFloat(updated.total as string),
      shippingAddress: updated.shippingAddress,
      notes: updated.notes,
      items: items.map((i) => ({
        id: i.id,
        catalogItemId: i.catalogItemId,
        catalogItemName: i.catalogItemName,
        quantity: i.quantity,
        unitPrice: parseFloat(i.unitPrice as string),
        totalPrice: parseFloat(i.totalPrice as string),
      })),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
    return;
  }

  // Real Stripe — verify the PaymentIntent succeeded before confirming
  try {
    const intent = await stripe.paymentIntents.retrieve(body.data.paymentIntentId);

    if (intent.status !== "succeeded") {
      res.status(402).json({ error: `Payment not complete: ${intent.status}` });
      return;
    }

    if (order.paymentStatus === "paid") {
      res.json({ ...order, paymentStatus: "paid" });
      return;
    }

    try {
      await deductPaidOrderInventory(order);
    } catch (err) {
      if (err instanceof PaymentInventoryError) {
        res.status(409).json({ error: "Insufficient inventory", catalogItemId: err.catalogItemId });
        return;
      }
      throw err;
    }
    const [updated] = await db
      .update(ordersTable)
      .set({ paymentStatus: "paid", status: "confirmed" })
      .where(eq(ordersTable.id, order.id))
      .returning();

    await writeAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "PAYMENT_CONFIRMED",
      tenantId: order.tenantId,
      resourceType: "order",
      resourceId: String(order.id),
      metadata: { paymentIntentId: body.data.paymentIntentId },
      ipAddress: req.ip,
    });

    // Dispatch woo-managed items AFTER payment is confirmed (fire-and-forget)
    void dispatchWooItemsAfterPayment(updated.id);

    res.json({ ...updated, paymentStatus: "paid" });
  } catch (err) {
    logger.error({ err }, "Payment confirmation failed");
    res.status(500).json({ error: "Payment confirmation error" });
  }
});

export default router;
