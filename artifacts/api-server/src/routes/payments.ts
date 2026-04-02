import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { db, ordersTable } from "@workspace/db";
import {
  TokenizePaymentBody,
  TokenizePaymentResponse,
  ConfirmPaymentParams,
  ConfirmPaymentBody,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, writeAuditLog } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2025-01-27.acacia" });
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
  if (order.customerId !== actor.id && actor.role === "customer") {
    res.status(403).json({ error: "Forbidden" });
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

  // Real Stripe
  try {
    const amountCents = Math.round(body.data.amount * 100);
    const currency = body.data.currency ?? "usd";

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      metadata: { orderId: String(order.id) },
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
  if (order.customerId !== actor.id && actor.role === "customer") {
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

    const { orderItemsTable, usersTable } = await import("@workspace/db");
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

    res.json({ ...updated, paymentStatus: "paid" });
  } catch (err) {
    logger.error({ err }, "Payment confirmation failed");
    res.status(500).json({ error: "Payment confirmation error" });
  }
});

export default router;
