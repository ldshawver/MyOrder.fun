import { and, eq, sql } from "drizzle-orm";
import { db, ordersTable, orderTaxSnapshotsTable, paymentAttemptsTable, paymentCapturesTable, paymentRefundsTable, paymentWebhookEventsTable } from "@workspace/db";
import type { PaymentProvider, PayPalTransmissionHeaders } from "./provider";
import type { EnabledPaymentConfig } from "./provider";
import { PayPalProviderError } from "./paypal";
import { consumeCustomerCredit, restoreCustomerCredit } from "./customerCredit";

const CURRENCY = "USD";
const money = (value: unknown) => Number(value).toFixed(2);
const sameMoney = (a: string, b: string) => Number(a).toFixed(2) === Number(b).toFixed(2);

export class PaymentServiceError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); this.name = "PaymentServiceError"; }
}

export class PaymentService {
  constructor(private readonly config: EnabledPaymentConfig, private readonly provider: PaymentProvider) {}

  async create(input: { tenantId: number; customerId: number; orderId: number; idempotencyKey: string }) {
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.customerId !== input.customerId) throw new PaymentServiceError(403, "ORDER_FORBIDDEN", "Forbidden");
      if (order.paymentStatus === "paid") throw new PaymentServiceError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      if (["cancelled", "refunded", "voided", "archived", "completed"].includes(order.status)) throw new PaymentServiceError(409, "INVALID_ORDER_STATE", "Order cannot be paid in its current state");
      if (!order.checkoutConversionSnapshot || !order.legalDisclaimerAccepted || !order.finalConfirmationAt) throw new PaymentServiceError(422, "CHECKOUT_NOT_VERIFIED", "Checkout conversion and confirmation are required");

      const [existing] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId), eq(paymentAttemptsTable.idempotencyKey, input.idempotencyKey))).limit(1);
      if (existing?.providerOrderId) return { attemptId: existing.id, providerOrderId: existing.providerOrderId, status: existing.state, replayed: true };

      const amount = money(order.remainingTenderAmount ?? order.total);
      if (Number(amount) <= 0) throw new PaymentServiceError(409, "NO_EXTERNAL_BALANCE", "Customer Credit covers the full order; no PayPal order is permitted");
      const [attempt] = existing ? [existing] : await tx.insert(paymentAttemptsTable).values({ tenantId: input.tenantId, orderId: input.orderId, provider: "paypal", providerEnvironment: this.config.environment, idempotencyKey: input.idempotencyKey, requestedAmount: amount, requestedCurrency: CURRENCY, state: "creating" }).returning();
      let providerOrder;
      try { providerOrder = await this.provider.createOrder({ amount: { value: amount, currency: CURRENCY }, requestId: `create-${attempt.id}`, internalOrderId: input.orderId }); }
      catch (error) { await tx.update(paymentAttemptsTable).set({ state: error instanceof PayPalProviderError && error.failureClass === "unknown_outcome" ? "reconciliation_required" : "failed", reconciliationState: error instanceof PayPalProviderError && error.failureClass === "unknown_outcome" ? "pending" : "not_required", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw error; }
      if (!sameMoney(providerOrder.amount.value, amount) || providerOrder.amount.currency !== CURRENCY) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "amount_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw new PaymentServiceError(502, "PROVIDER_AMOUNT_MISMATCH", "Provider order amount mismatch"); }
      await tx.update(paymentAttemptsTable).set({ providerOrderId: providerOrder.id, state: "created" }).where(eq(paymentAttemptsTable.id, attempt.id));
      return { attemptId: attempt.id, providerOrderId: providerOrder.id, approvalUrl: providerOrder.approvalUrl, status: "created", replayed: false };
    });
  }

  async capture(input: { tenantId: number; customerId: number; orderId: number; attemptId: number; idempotencyKey: string; finalize: (order: typeof ordersTable.$inferSelect) => Promise<void> }) {
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.customerId !== input.customerId) throw new PaymentServiceError(403, "ORDER_FORBIDDEN", "Forbidden");
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.id, input.attemptId), eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId))).limit(1);
      if (!attempt?.providerOrderId) throw new PaymentServiceError(409, "PAYMENT_NOT_READY", "Payment attempt is not ready");
      const [existingCapture] = await tx.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, attempt.id)).limit(1);
      if (existingCapture?.state === "completed" && order.paymentStatus === "paid") return { status: "captured", captureId: existingCapture.providerCaptureId, replayed: true };
      if (order.paymentStatus === "paid") throw new PaymentServiceError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      await tx.update(paymentAttemptsTable).set({ state: "capturing" }).where(eq(paymentAttemptsTable.id, attempt.id));
      let capture;
      try { capture = await this.provider.captureOrder(attempt.providerOrderId, `capture-${attempt.id}`); }
      catch (error) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "pending", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw error; }
      if (capture.orderId !== attempt.providerOrderId || capture.status !== "COMPLETED" || !sameMoney(capture.amount.value, attempt.requestedAmount) || capture.amount.currency !== attempt.requestedCurrency) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "capture_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw new PaymentServiceError(409, "CAPTURE_MISMATCH", "Capture requires reconciliation"); }
      await tx.insert(paymentCapturesTable).values({ tenantId: input.tenantId, paymentAttemptId: attempt.id, provider: "paypal", providerEnvironment: this.config.environment, providerCaptureId: capture.captureId, amount: capture.amount.value, currency: capture.amount.currency, state: "completed", capturedAt: new Date() }).onConflictDoNothing();
      try { await input.finalize(order); }
      catch (error) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "pending", failureClass: "local_finalize_failed" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw error; }
      const creditCents = Math.round(Number(order.customerCreditApplied) * 100);
      if (creditCents > 0) await consumeCustomerCredit(tx, { tenantId: input.tenantId, customerId: order.customerId, actorUserId: input.customerId, orderId: order.id, amountCents: creditCents, idempotencyKey: `consume:capture:${attempt.id}` });
      const tender = capture.fundingSource === "card" ? "paypal_card" : "paypal";
      await tx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: creditCents > 0 ? `customer_credit+${tender}` : tender, selectedPaymentMethod: tender, paymentIntentId: capture.captureId }).where(and(eq(ordersTable.id, order.id), eq(ordersTable.tenantId, order.tenantId)));
      await tx.update(paymentAttemptsTable).set({ state: "captured", fundingSource: capture.fundingSource ?? "paypal", capturedAmount: capture.amount.value, capturedCurrency: capture.amount.currency, reconciliationState: "not_required" }).where(eq(paymentAttemptsTable.id, attempt.id));
      return { status: "captured", captureId: capture.captureId, replayed: false };
    });
  }

  async refund(input: { tenantId: number; orderId: number; actorUserId: number; idempotencyKey: string; amount?: string; reason: string }) {
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId), eq(paymentAttemptsTable.state, "captured"))).limit(1);
      if (!attempt) throw new PaymentServiceError(409, "NO_CAPTURE", "No captured PayPal payment exists");
      const [capture] = await tx.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, attempt.id)).limit(1);
      if (!capture) throw new PaymentServiceError(409, "NO_CAPTURE", "No captured PayPal payment exists");
      const completed = await tx.select().from(paymentRefundsTable).where(and(eq(paymentRefundsTable.paymentCaptureId, capture.id), eq(paymentRefundsTable.state, "completed")));
      const refunded = completed.reduce((sum, row) => sum + Number(row.amount), 0); const amount = Number(input.amount ?? (Number(capture.amount) - refunded).toFixed(2));
      if (!Number.isFinite(amount) || amount <= 0 || refunded + amount > Number(capture.amount)) throw new PaymentServiceError(409, "INVALID_REFUND_AMOUNT", "Refund exceeds captured amount");
      const [existing] = await tx.select().from(paymentRefundsTable).where(and(eq(paymentRefundsTable.tenantId, input.tenantId), eq(paymentRefundsTable.paymentCaptureId, capture.id), eq(paymentRefundsTable.idempotencyKey, input.idempotencyKey))).limit(1);
      if (existing?.state === "completed") return { status: "completed", refundId: existing.providerRefundId, replayed: true };
      const [row] = existing ? [existing] : await tx.insert(paymentRefundsTable).values({ tenantId: input.tenantId, paymentCaptureId: capture.id, idempotencyKey: input.idempotencyKey, amount: amount.toFixed(2), currency: capture.currency, reason: input.reason.slice(0, 500), actorUserId: input.actorUserId }).returning();
      let refund;
      try { refund = await this.provider.refundCapture(capture.providerCaptureId, { value: amount.toFixed(2), currency: capture.currency }, `refund-${row.id}`, input.reason); }
      catch (error) { await tx.update(paymentRefundsTable).set({ state: "reconciliation_required", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentRefundsTable.id, row.id)); throw error; }
      const completedState = refund.status === "COMPLETED" ? "completed" : "reconciliation_required";
      await tx.update(paymentRefundsTable).set({ providerRefundId: refund.refundId, state: completedState }).where(eq(paymentRefundsTable.id, row.id));
      if (completedState === "completed") {
        const fullProviderRefund = refunded + amount === Number(capture.amount);
        const creditCents = Math.round(Number(order.customerCreditApplied) * 100);
        if (fullProviderRefund && creditCents > 0) await restoreCustomerCredit(tx, { tenantId: input.tenantId, customerId: order.customerId, actorUserId: input.actorUserId, orderId: order.id, amountCents: creditCents, paymentRefundId: row.id, idempotencyKey: `restore:refund:${row.id}`, reason: "Original-tender refund restoration" });
        const fullOrderRefund = fullProviderRefund;
        const [tax] = await tx.select().from(orderTaxSnapshotsTable).where(and(eq(orderTaxSnapshotsTable.tenantId, input.tenantId), eq(orderTaxSnapshotsTable.orderId, input.orderId))).limit(1);
        if (tax) {
          const priorTaxRefunded = Number(tax.taxRefunded); const orderTotal = Number(order.total);
          const economicRefund = amount + (fullProviderRefund ? creditCents / 100 : 0);
          const taxRefund = fullOrderRefund ? Number(tax.taxCollected) : Math.round(Number(tax.taxCollected) * economicRefund / orderTotal * 100) / 100;
          await tx.update(orderTaxSnapshotsTable).set({ taxRefunded: Math.min(Number(tax.taxCollected), priorTaxRefunded + taxRefund).toFixed(2) }).where(eq(orderTaxSnapshotsTable.id, tax.id));
        }
        await tx.update(paymentCapturesTable).set({ state: fullProviderRefund ? "refunded" : "partially_refunded" }).where(eq(paymentCapturesTable.id, capture.id));
        await tx.update(paymentAttemptsTable).set({ state: fullProviderRefund ? "refunded" : "partially_refunded" }).where(eq(paymentAttemptsTable.id, attempt.id));
        await tx.update(ordersTable).set(fullOrderRefund ? { paymentStatus: "refunded", status: "refunded" } : { paymentStatus: "partially_refunded" }).where(eq(ordersTable.id, input.orderId));
      }
      return { status: completedState, refundId: refund.refundId, replayed: false };
    });
  }

  async reconcile(input: { tenantId: number; orderId: number; finalize: (order: typeof ordersTable.$inferSelect) => Promise<void> }) {
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId))).limit(1);
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId))).orderBy(sql`${paymentAttemptsTable.createdAt} DESC`).limit(1);
      if (!order || !attempt?.providerOrderId) throw new PaymentServiceError(404, "PAYMENT_NOT_FOUND", "Payment attempt not found");
      const authoritative = await this.provider.getOrder(attempt.providerOrderId);
      if (authoritative.id !== attempt.providerOrderId || !sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "reconciliation_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw new PaymentServiceError(409, "RECONCILIATION_MISMATCH", "Provider state does not match the order"); }
      if (authoritative.capture?.status === "COMPLETED") {
        const capture = await this.provider.getCapture(authoritative.capture.captureId);
        if (capture.orderId !== attempt.providerOrderId || !sameMoney(capture.amount.value, attempt.requestedAmount) || capture.amount.currency !== attempt.requestedCurrency) throw new PaymentServiceError(409, "RECONCILIATION_MISMATCH", "Capture does not match the order");
        await tx.insert(paymentCapturesTable).values({ tenantId: input.tenantId, paymentAttemptId: attempt.id, provider: "paypal", providerEnvironment: this.config.environment, providerCaptureId: capture.captureId, amount: capture.amount.value, currency: capture.amount.currency, state: "completed", capturedAt: new Date() }).onConflictDoNothing();
        if (order.paymentStatus !== "paid") await input.finalize(order);
        await tx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "paypal_verified", selectedPaymentMethod: "paypal_verified", paymentIntentId: capture.captureId }).where(eq(ordersTable.id, order.id));
        await tx.update(paymentAttemptsTable).set({ state: "captured", capturedAmount: capture.amount.value, capturedCurrency: capture.amount.currency, reconciliationState: "resolved", failureClass: null }).where(eq(paymentAttemptsTable.id, attempt.id));
        return { localState: "captured", providerState: capture.status, recovered: order.paymentStatus !== "paid" };
      }
      const nextState = authoritative.status === "APPROVED" ? "approved" : authoritative.status === "CREATED" ? "created" : "reconciliation_required";
      await tx.update(paymentAttemptsTable).set({ state: nextState, reconciliationState: nextState === "reconciliation_required" ? "manual_review" : "not_required" }).where(eq(paymentAttemptsTable.id, attempt.id));
      return { localState: nextState, providerState: authoritative.status, recovered: false };
    });
  }

  async verifyAndRecordWebhook(headers: PayPalTransmissionHeaders, event: { id: string; event_type: string; resource?: Record<string, unknown> }) {
    if (!await this.provider.verifyWebhook(headers, event)) throw new PaymentServiceError(400, "INVALID_WEBHOOK_SIGNATURE", "Invalid webhook signature");
    const allowed = new Set(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);
    const environment = this.config.environment;
    const inserted = await db.insert(paymentWebhookEventsTable).values({ provider: "paypal", providerEnvironment: environment, providerEventId: event.id, eventType: event.event_type, processingState: allowed.has(event.event_type) ? "verified" : "ignored" }).onConflictDoNothing().returning();
    if (inserted.length === 0) return { replayed: true, processed: true };
    if (!allowed.has(event.event_type)) return { replayed: false, processed: false };
    // The resource identifier is used only to retrieve authoritative provider
    // state. It is never trusted as the local order mapping.
    const resourceId = typeof event.resource?.id === "string" ? event.resource.id : undefined;
    if (!resourceId) { await db.update(paymentWebhookEventsTable).set({ processingState: "failed", failureClass: "missing_resource_id", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); throw new PaymentServiceError(400, "INVALID_WEBHOOK_RESOURCE", "Invalid webhook resource"); }
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
      const authoritative = await this.provider.getOrder(resourceId);
      const [attempt] = await db.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.provider, "paypal"), eq(paymentAttemptsTable.providerEnvironment, environment), eq(paymentAttemptsTable.providerOrderId, authoritative.id))).limit(1);
      if (!attempt) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", failureClass: "unmapped_provider_order", providerOrderId: authoritative.id, processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      if (!sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) throw new PaymentServiceError(409, "WEBHOOK_AMOUNT_MISMATCH", "Webhook order requires reconciliation");
      await db.update(paymentAttemptsTable).set({ state: "approved" }).where(eq(paymentAttemptsTable.id, attempt.id));
      await db.update(paymentWebhookEventsTable).set({ tenantId: attempt.tenantId, paymentAttemptId: attempt.id, providerOrderId: authoritative.id, processingState: "processed", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id));
    } else {
      const authoritative = await this.provider.getCapture(resourceId);
      const [attempt] = await db.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.provider, "paypal"), eq(paymentAttemptsTable.providerEnvironment, environment), eq(paymentAttemptsTable.providerOrderId, authoritative.orderId))).limit(1);
      if (!attempt) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", failureClass: "unmapped_capture", providerOrderId: authoritative.orderId, providerCaptureId: authoritative.captureId, processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      if (!sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) { await db.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "webhook_amount_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw new PaymentServiceError(409, "WEBHOOK_AMOUNT_MISMATCH", "Webhook capture requires reconciliation"); }
      const alreadyFinalized = attempt.state === "captured" || attempt.state === "refunded" || attempt.state === "partially_refunded";
      if (!alreadyFinalized) await db.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "pending", failureClass: `webhook_${event.event_type.toLowerCase().replaceAll(".", "_")}` }).where(eq(paymentAttemptsTable.id, attempt.id));
      await db.update(paymentWebhookEventsTable).set({ tenantId: attempt.tenantId, paymentAttemptId: attempt.id, providerOrderId: authoritative.orderId, providerCaptureId: authoritative.captureId, processingState: "processed", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id));
    }
    return { replayed: false, processed: true };
  }
}
