import { Router, type IRouter, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { requireOnlinePayments } from "../payments/config";
import { loadTenantPaymentConfig } from "../payments/tenantConfig";
import { PayPalProvider, PayPalProviderError } from "../payments/paypal";
import { PaymentService, PaymentServiceError } from "../payments/service";
import type { PayPalTransmissionHeaders } from "../payments/provider";
import { deductPaidOrderInventory } from "../payments/inventory";
import { db, ordersTable, paymentAttemptsTable, paymentCapturesTable, paymentRefundsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { releaseCustomerCredit } from "../payments/customerCredit";
import { queueUberDeliveryForPaidOrder } from "../lib/uberFulfillment";
import { logger } from "../lib/logger";
import { requireTenantContext } from "../lib/tenantContext";
import { releaseInventoryReservationsForOrder } from "../lib/inventoryReservations";

const router: IRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Payment requests rate-limited" } });
const auth = [limiter, requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext] as const;
const Id = z.coerce.number().int().positive();
const Empty = z.object({}).strict();
const Capture = z.object({ attemptId: z.number().int().positive() }).strict();
const Refund = z.object({ amount: z.string().regex(/^\d+\.\d{2}$/).optional(), reason: z.string().trim().min(3).max(500) }).strict();

function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(value)) throw new PaymentServiceError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  return value;
}
async function service(tenantId: number) { const config = requireOnlinePayments(await loadTenantPaymentConfig(tenantId)); return new PaymentService(config, new PayPalProvider(config)); }
function fail(res: Response, error: unknown) {
  const known = error as { statusCode?: number; code?: string };
  res.status(known.statusCode ?? 502).json({ error: known.code ?? "PAYMENT_PROVIDER_ERROR" });
}

/** An untrusted webhook may select a candidate tenant only through an existing
 * provider identity. The selected tenant's secret still verifies the signature. */
async function webhookTenant(event: { resource?: Record<string, unknown> }): Promise<{ tenantId: number; environment: string } | null> {
  const resource = event.resource ?? {};
  const related = (resource.supplementary_data as { related_ids?: Record<string, unknown> } | undefined)?.related_ids ?? {};
  const ids = [resource.id, related.order_id, related.capture_id].filter((value): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value));
  const matches = new Map<string, { tenantId: number; environment: string }>();
  for (const id of ids) {
    const attempts = await db.select({ tenantId: paymentAttemptsTable.tenantId, environment: paymentAttemptsTable.providerEnvironment }).from(paymentAttemptsTable)
      .where(and(eq(paymentAttemptsTable.provider, "paypal"), eq(paymentAttemptsTable.providerOrderId, id)));
    const captures = await db.select({ tenantId: paymentCapturesTable.tenantId, environment: paymentCapturesTable.providerEnvironment }).from(paymentCapturesTable)
      .where(and(eq(paymentCapturesTable.provider, "paypal"), eq(paymentCapturesTable.providerCaptureId, id)));
    const refunds = await db.select({ tenantId: paymentRefundsTable.tenantId, environment: paymentCapturesTable.providerEnvironment }).from(paymentRefundsTable)
      .innerJoin(paymentCapturesTable, eq(paymentRefundsTable.paymentCaptureId, paymentCapturesTable.id))
      .where(eq(paymentRefundsTable.providerRefundId, id));
    for (const match of [...attempts, ...captures, ...refunds]) matches.set(`${match.tenantId}:${match.environment}`, match);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

router.get("/payments/config", ...auth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { const config = await loadTenantPaymentConfig(req.authorizedTenantId!); res.json(config.enabled ? { enabled: true, provider: "paypal", mode: config.mode, clientId: config.clientId, currency: "USD", countryCode: "US" } : { enabled: false, provider: "paypal", mode: "disabled" }); }
  catch { res.status(503).json({ enabled: false, provider: "paypal", mode: "disabled" }); }
});

router.post("/payments/paypal/orders/:orderId", ...auth, async (req, res) => {
  try { Empty.parse(req.body); const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await (await service(req.authorizedTenantId!)).create({ tenantId: req.authorizedTenantId!, customerId: actor.id, orderId, idempotencyKey: key(req.get("Idempotency-Key")) }); res.status(result.replayed ? 200 : 201).json(result); }
  catch (error) { fail(res, error); }
});

router.post("/payments/paypal/orders/:orderId/capture", ...auth, async (req, res) => {
  let body: z.infer<typeof Capture> | undefined; let orderId: number | undefined;
  try { body = Capture.parse(req.body); orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await (await service(req.authorizedTenantId!)).capture({ tenantId: req.authorizedTenantId!, customerId: actor.id, orderId, attemptId: body.attemptId, idempotencyKey: key(req.get("Idempotency-Key")), finalize: (order, tx) => deductPaidOrderInventory(order, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip }, tx) }); await queueUberDeliveryForPaidOrder(req.authorizedTenantId!, orderId).catch(error => logger.warn({ tenantId: req.authorizedTenantId!, orderId, error: error instanceof Error ? error.message : "unknown" }, "Uber Direct handoff will require recovery")); await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "PAYPAL_CAPTURE_VERIFIED", tenantId: req.authorizedTenantId!, resourceType: "order", resourceId: String(orderId), metadata: { replayed: result.replayed }, ipAddress: req.ip }); res.json(result); }
  catch (error) {
    const actor = req.dbUser!;
    // Release only on a definitive decline. Unknown outcomes retain the
    // reservation until provider reconciliation prevents double spending.
    if (body && orderId && error instanceof PayPalProviderError && error.failureClass === "declined") {
      await db.transaction(async tx => {
        const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, req.authorizedTenantId!), eq(ordersTable.id, orderId!), eq(ordersTable.customerId, actor.id))).limit(1);
        if (order && order.paymentStatus !== "paid") {
          await tx.update(paymentAttemptsTable).set({ state: "failed", failureClass: "declined", reconciliationState: "not_required" }).where(and(eq(paymentAttemptsTable.tenantId, req.authorizedTenantId!), eq(paymentAttemptsTable.id, body!.attemptId), eq(paymentAttemptsTable.orderId, order.id)));
          await releaseInventoryReservationsForOrder(tx, req.authorizedTenantId!, order.id);
        }
        const amountCents = Math.round(Number(order?.customerCreditApplied ?? 0) * 100);
        if (order && amountCents > 0) {
          await releaseCustomerCredit(tx, { tenantId: req.authorizedTenantId!, customerId: actor.id, actorUserId: actor.id, orderId: order.id, amountCents, idempotencyKey: `release:declined:${body!.attemptId}`, reason: "PayPal capture declined" });
          await tx.update(ordersTable).set({ customerCreditApplied: "0.00", remainingTenderAmount: String(Number(order.total).toFixed(2)) }).where(and(eq(ordersTable.tenantId, req.authorizedTenantId!), eq(ordersTable.id, order.id)));
        }
      }).catch(() => undefined);
    }
    fail(res, error);
  }
});

router.post("/admin/payments/paypal/orders/:orderId/refund", ...auth, requirePermission("orders.refund"), async (req, res) => {
  try { const body = Refund.parse(req.body); const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await (await service(req.authorizedTenantId!)).refund({ tenantId: req.authorizedTenantId!, orderId, actorUserId: actor.id, idempotencyKey: key(req.get("Idempotency-Key")), amount: body.amount, reason: body.reason }); await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "PAYPAL_REFUND", tenantId: req.authorizedTenantId!, resourceType: "order", resourceId: String(orderId), metadata: { status: result.status, replayed: result.replayed }, ipAddress: req.ip }); res.json(result); }
  catch (error) { fail(res, error); }
});

router.get("/admin/payments/paypal/orders/:orderId/reconciliation", ...auth, requirePermission("orders.refund"), async (req, res) => {
  try { const orderId = Id.parse(req.params.orderId); const actor = req.dbUser!; const result = await (await service(req.authorizedTenantId!)).reconcile({ tenantId: req.authorizedTenantId!, orderId, finalize: (order, tx) => deductPaidOrderInventory(order, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip }, tx) }); if (result.localState === "captured") await queueUberDeliveryForPaidOrder(req.authorizedTenantId!, orderId).catch(error => logger.warn({ tenantId: req.authorizedTenantId!, orderId, error: error instanceof Error ? error.message : "unknown" }, "Uber Direct handoff will require recovery")); res.json(result); }
  catch (error) { fail(res, error); }
});

router.post("/webhooks/paypal", limiter, async (req, res) => {
  let stage = "raw_body";
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (!raw) throw new PaymentServiceError(400, "WEBHOOK_RAW_BODY_MISSING", "PayPal webhook requires the original request body");
    if (raw.length === 0 || raw.length > 262_144) throw new PaymentServiceError(400, "INVALID_WEBHOOK_BODY", "Invalid webhook body");
    stage = "json_body";
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(raw.toString("utf8")); }
    catch { throw new PaymentServiceError(400, "INVALID_WEBHOOK_JSON", "Invalid webhook JSON"); }
    const parsedEvent = z.object({ id: z.string().min(1).max(100), event_type: z.string().min(1).max(100), resource: z.record(z.string(), z.unknown()).optional() }).passthrough().safeParse(parsedBody);
    if (!parsedEvent.success) throw new PaymentServiceError(400, "INVALID_WEBHOOK_EVENT", "Invalid webhook event");
    // Zod moves declared keys ahead of passthrough keys. PayPal's verification
    // endpoint needs the event in the original JSON key order, so validate but
    // pass the object parsed directly from the preserved raw body.
    const event = parsedBody as typeof parsedEvent.data;
    stage = "signature_headers";
    const header = (name: string) => {
      const value = req.get(name);
      if (!value) throw new PaymentServiceError(400, "MISSING_WEBHOOK_SIGNATURE", "Missing webhook signature metadata");
      if (value.length > 2000 || /[\r\n]/.test(value)) throw new PaymentServiceError(400, "MALFORMED_WEBHOOK_SIGNATURE", "Malformed webhook signature metadata");
      return value;
    };
    const headers: PayPalTransmissionHeaders = { transmissionId: header("PayPal-Transmission-Id"), transmissionTime: header("PayPal-Transmission-Time"), transmissionSignature: header("PayPal-Transmission-Sig"), certificateUrl: header("PayPal-Cert-Url"), authAlgorithm: header("PayPal-Auth-Algo") };
    stage = "tenant_identity";
    const identity = await webhookTenant(event);
    if (!identity) throw new PaymentServiceError(400, "INVALID_WEBHOOK_SIGNATURE", "Unknown PayPal event identity");
    stage = "tenant_configuration";
    const config = requireOnlinePayments(await loadTenantPaymentConfig(identity.tenantId));
    if (config.environment !== identity.environment) throw new PaymentServiceError(400, "INVALID_WEBHOOK_SIGNATURE", "PayPal environment mismatch");
    stage = "verification_and_persistence";
    const result = await new PaymentService(config, new PayPalProvider(config)).verifyAndRecordWebhook(headers, event);
    res.status(200).json({ received: true, replayed: result.replayed });
  } catch (error) {
    const known = error as { code?: string; failureClass?: string };
    logger.warn({ stage, code: known.code ?? "UNCLASSIFIED", providerFailureClass: known.failureClass ?? null }, "PayPal webhook rejected");
    fail(res, error);
  }
});

export default router;
