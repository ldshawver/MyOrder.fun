import { Router, type IRouter, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { loadPaymentConfig, requireOnlinePayments } from "../payments/config";
import { PayPalProvider, PayPalProviderError } from "../payments/paypal";
import { PaymentService, PaymentServiceError } from "../payments/service";
import type { PayPalTransmissionHeaders } from "../payments/provider";
import { deductPaidOrderInventory } from "../payments/inventory";
import { db, ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { releaseCustomerCredit } from "../payments/customerCredit";

const router: IRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Payment requests rate-limited" } });
const auth = [limiter, requireAuth, loadDbUser, requireDbUser, requireApproved] as const;
const Id = z.coerce.number().int().positive();
const Empty = z.object({}).strict();
const Capture = z.object({ attemptId: z.number().int().positive() }).strict();
const Refund = z.object({ amount: z.string().regex(/^\d+\.\d{2}$/).optional(), reason: z.string().trim().min(3).max(500) }).strict();

function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(value)) throw new PaymentServiceError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  return value;
}
function service() { const config = requireOnlinePayments(loadPaymentConfig()); return new PaymentService(config, new PayPalProvider(config)); }
function fail(res: Response, error: unknown) {
  const known = error as { statusCode?: number; code?: string };
  res.status(known.statusCode ?? 502).json({ error: known.code ?? "PAYMENT_PROVIDER_ERROR" });
}

router.get("/payments/config", (_req, res) => {
  try { const config = loadPaymentConfig(); res.json(config.enabled ? { enabled: true, provider: "paypal", mode: config.mode, clientId: config.clientId, currency: "USD" } : { enabled: false, provider: "paypal", mode: "disabled" }); }
  catch { res.status(503).json({ enabled: false, provider: "paypal", mode: "disabled" }); }
});

router.get("/payments/paypal/browser-token", ...auth, async (_req, res) => {
  try { const config = requireOnlinePayments(loadPaymentConfig()); const token = await new PayPalProvider(config).browserSafeClientToken(); res.setHeader("Cache-Control", "no-store"); res.json(token); }
  catch (error) { fail(res, error); }
});

router.post("/payments/paypal/orders/:orderId", ...auth, async (req, res) => {
  try { Empty.parse(req.body); const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await service().create({ tenantId: actor.tenantId!, customerId: actor.id, orderId, idempotencyKey: key(req.get("Idempotency-Key")) }); res.status(result.replayed ? 200 : 201).json(result); }
  catch (error) { fail(res, error); }
});

router.post("/payments/paypal/orders/:orderId/capture", ...auth, async (req, res) => {
  let body: z.infer<typeof Capture> | undefined; let orderId: number | undefined;
  try { body = Capture.parse(req.body); orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await service().capture({ tenantId: actor.tenantId!, customerId: actor.id, orderId, attemptId: body.attemptId, idempotencyKey: key(req.get("Idempotency-Key")), finalize: order => deductPaidOrderInventory(order, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip }) }); await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "PAYPAL_CAPTURE_VERIFIED", tenantId: actor.tenantId!, resourceType: "order", resourceId: String(orderId), metadata: { replayed: result.replayed }, ipAddress: req.ip }); res.json(result); }
  catch (error) {
    const actor = req.dbUser!;
    // Release only on a definitive decline. Unknown outcomes retain the
    // reservation until provider reconciliation prevents double spending.
    if (body && orderId && error instanceof PayPalProviderError && error.failureClass === "declined") {
      await db.transaction(async tx => {
        const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, orderId!), eq(ordersTable.customerId, actor.id))).limit(1);
        const amountCents = Math.round(Number(order?.customerCreditApplied ?? 0) * 100);
        if (order && amountCents > 0) {
          await releaseCustomerCredit(tx, { tenantId: actor.tenantId!, customerId: actor.id, actorUserId: actor.id, orderId: order.id, amountCents, idempotencyKey: `release:declined:${body!.attemptId}`, reason: "PayPal capture declined" });
          await tx.update(ordersTable).set({ customerCreditApplied: "0.00", remainingTenderAmount: String(Number(order.total).toFixed(2)) }).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, order.id)));
        }
      }).catch(() => undefined);
    }
    fail(res, error);
  }
});

router.post("/admin/payments/paypal/orders/:orderId/refund", ...auth, requirePermission("orders.refund"), async (req, res) => {
  try { const body = Refund.parse(req.body); const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await service().refund({ tenantId: actor.tenantId!, orderId, actorUserId: actor.id, idempotencyKey: key(req.get("Idempotency-Key")), amount: body.amount, reason: body.reason }); await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "PAYPAL_REFUND", tenantId: actor.tenantId!, resourceType: "order", resourceId: String(orderId), metadata: { status: result.status, replayed: result.replayed }, ipAddress: req.ip }); res.json(result); }
  catch (error) { fail(res, error); }
});

router.get("/admin/payments/paypal/orders/:orderId/reconciliation", ...auth, requirePermission("orders.refund"), async (req, res) => {
  try { const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await service().reconcile({ tenantId: actor.tenantId!, orderId, finalize: order => deductPaidOrderInventory(order, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip }) }); res.json(result); }
  catch (error) { fail(res, error); }
});

router.post("/webhooks/paypal", limiter, async (req, res) => {
  try {
    const config = requireOnlinePayments(loadPaymentConfig());
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (!raw || raw.length === 0 || raw.length > 262_144) throw new PaymentServiceError(400, "INVALID_WEBHOOK_BODY", "Invalid webhook body");
    const event = z.object({ id: z.string().min(1).max(100), event_type: z.string().min(1).max(100), resource: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(JSON.parse(raw.toString("utf8")));
    const header = (name: string) => { const value = req.get(name); if (!value || value.length > 2000) throw new PaymentServiceError(400, "MISSING_WEBHOOK_SIGNATURE", "Missing webhook signature metadata"); return value; };
    const headers: PayPalTransmissionHeaders = { transmissionId: header("PayPal-Transmission-Id"), transmissionTime: header("PayPal-Transmission-Time"), transmissionSignature: header("PayPal-Transmission-Sig"), certificateUrl: header("PayPal-Cert-Url"), authAlgorithm: header("PayPal-Auth-Algo") };
    const result = await new PaymentService(config, new PayPalProvider(config)).verifyAndRecordWebhook(headers, event);
    res.status(200).json({ received: true, replayed: result.replayed });
  } catch (error) { fail(res, error); }
});

export default router;
