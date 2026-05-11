import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { db, ordersTable, orderItemsTable } from "@workspace/db";
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
  buildMerchantPayloadLines,
  computeCheckoutTotals,
  CheckoutMappingError,
  type NormalizedCartLine,
} from "../lib/checkoutNormalizer";
import { buildStripeIntentPayload, payloadContainsAlavontLeak } from "../lib/stripePayload";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

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
router.post("/payments/tokenize", async (req, res): Promise<void> => {
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
      { orderId: order.id, merchantLines: buildMerchantPayloadLines(normalizedLines), actorId: actor.id, serverAmount },
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

// POST /api/payments/:orderId/confirm
// Verifies the PaymentIntent succeeded via Stripe, then marks the order as paid.
router.post("/payments/:orderId/confirm", async (req, res): Promise<void> => {
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

  const stripe = getStripeClient();
  const isSandbox = !stripe || body.data.paymentIntentId.includes("sandbox");

  // Sandbox mode — auto-confirm without calling Stripe
  if (isSandbox) {
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
