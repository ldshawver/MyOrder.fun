import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, ordersTable, orderTaxSnapshotsTable, inventoryReservationsTable, paymentAttemptsTable, paymentCapturesTable, paymentRefundsTable, paymentWebhookEventsTable, auditLogsTable, usersTable } from "@workspace/db";
import type { PaymentProvider, PayPalTransmissionHeaders } from "./provider";
import type { EnabledPaymentConfig } from "./provider";
import { PayPalProviderError } from "./paypal";
import { consumeCustomerCredit, releaseCustomerCredit, restoreCustomerCredit } from "./customerCredit";
import { logger } from "../lib/logger";
import { releaseInventoryReservationsForOrder } from "../lib/inventoryReservations";
import { ensurePaidOrderInventoryReserved, PaymentInventoryError, type PaymentTransaction } from "./inventory";
import { computeTenderTaxCents, centsToDollars, dollarsToCents } from "../lib/tenderTax";
import { getCheckoutTaxSettings } from "../lib/checkoutNormalizer";

const CURRENCY = "USD";
const sameMoney = (a: string, b: string) => {
  try { return dollarsToCents(a) === dollarsToCents(b); }
  catch { return false; }
};

export class PaymentServiceError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); this.name = "PaymentServiceError"; }
}

export class PaymentService {
  constructor(private readonly config: EnabledPaymentConfig, private readonly provider: PaymentProvider) {}

  async create(input: { tenantId: number; customerId: number; orderId: number; idempotencyKey: string }) {
    const outcome = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.customerId !== input.customerId) throw new PaymentServiceError(403, "ORDER_FORBIDDEN", "Forbidden");
      if (order.paymentStatus === "paid") throw new PaymentServiceError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      if (Number((order.taxSnapshot as { schemaVersion?: unknown } | null)?.schemaVersion) >= 3
        && !["paypal", "paypal_card"].includes(order.selectedPaymentMethod ?? "")) {
        throw new PaymentServiceError(409, "TENDER_MISMATCH", "Order was not confirmed for PayPal tender");
      }
      if (["cancelled", "refunded", "voided", "archived", "completed"].includes(order.status)) throw new PaymentServiceError(409, "INVALID_ORDER_STATE", "Order cannot be paid in its current state");
      if (!order.checkoutConversionSnapshot || !order.legalDisclaimerAccepted || !order.finalConfirmationAt) throw new PaymentServiceError(422, "CHECKOUT_NOT_VERIFIED", "Checkout conversion and confirmation are required");

      const [existing] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId), eq(paymentAttemptsTable.idempotencyKey, input.idempotencyKey))).limit(1);
      if (existing?.state === "failed") throw new PaymentServiceError(409, "PAYMENT_ATTEMPT_FAILED", "Start a new payment attempt with a new idempotency key");
      if (existing?.state === "reconciliation_required" || existing?.state === "creating") throw new PaymentServiceError(409, "PAYMENT_RECONCILIATION_REQUIRED", "Resolve the existing payment attempt before retrying");
      if (existing?.providerOrderId) return { attemptId: existing.id, providerOrderId: existing.providerOrderId, status: existing.state, replayed: true };
      const [unresolved] = await tx.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(and(
        eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId),
        inArray(paymentAttemptsTable.state, ["creating", "created", "approved", "capturing", "reconciliation_required"]),
      )).limit(1);
      if (unresolved) throw new PaymentServiceError(409, "PAYMENT_RECONCILIATION_REQUIRED", "Resolve the existing payment attempt before retrying");

      try { await ensurePaidOrderInventoryReserved(tx, order); }
      catch (error) {
        if (error instanceof PaymentInventoryError) throw new PaymentServiceError(409, "INSUFFICIENT_INVENTORY", error.message);
        throw error;
      }

      // A new browser session must resume an existing durable PayPal order,
      // rather than create a second provider order for the same MyOrder
      // checkout when a popup was dismissed, a page was refreshed, or a
      // network response was lost.
      const [activeAttempt] = await tx.select().from(paymentAttemptsTable).where(and(
        eq(paymentAttemptsTable.tenantId, input.tenantId),
        eq(paymentAttemptsTable.orderId, input.orderId),
        inArray(paymentAttemptsTable.state, ["created", "capturing", "reconciliation_required"]),
      )).orderBy(sql`${paymentAttemptsTable.createdAt} DESC`).limit(1);
      if (activeAttempt?.providerOrderId) return { attemptId: activeAttempt.id, providerOrderId: activeAttempt.providerOrderId, status: activeAttempt.state, replayed: true };

      const locationId = Number((order.taxSnapshot as { locationId?: unknown } | null)?.locationId);
      const settings = await getCheckoutTaxSettings(input.tenantId, Number.isInteger(locationId) && locationId > 0 ? locationId : undefined);
      const taxableMerchandiseCents = dollarsToCents(order.taxableSubtotal ?? order.subtotal);
      const creditCents = dollarsToCents(order.customerCreditApplied);
      const baseTotalCents = dollarsToCents(order.total) - dollarsToCents(order.tax);
      const { taxableBaseCents, taxCents } = computeTenderTaxCents({ taxableMerchandiseCents, nonTaxableFundingCents: creditCents, taxRate: settings.taxRate });
      const totalCents = baseTotalCents + taxCents;
      const remainingCents = totalCents - creditCents;
      if (order.financialFinalizedAt && (dollarsToCents(order.tax) !== taxCents || dollarsToCents(order.total) !== totalCents || dollarsToCents(order.remainingTenderAmount) !== remainingCents)) {
        throw new PaymentServiceError(409, "FINANCIAL_SNAPSHOT_MISMATCH", "Order financial snapshot requires reconciliation");
      }
      const checkoutSnapshot = order.checkoutConversionSnapshot as Record<string, unknown> | null;
      const pricingSnapshot = checkoutSnapshot?.pricingSnapshot as Record<string, unknown> | undefined;
      const tipSnapshot = checkoutSnapshot?.tip as { amount?: unknown } | undefined;
      const tipCents = typeof tipSnapshot?.amount === "number" || typeof tipSnapshot?.amount === "string" ? dollarsToCents(tipSnapshot.amount) : 0;
      const finalCheckoutSnapshot = checkoutSnapshot && pricingSnapshot ? {
        ...checkoutSnapshot,
        pricingSnapshot: { ...pricingSnapshot, tax: taxCents / 100, customerTax: taxCents / 100, total: totalCents / 100,
          totalBeforeTip: (totalCents - tipCents) / 100 },
      } : checkoutSnapshot;
      const tenderAllocation = { customerCreditCents: creditCents, paypalMerchandiseCents: taxableBaseCents, paypalTaxCents: taxCents };
      const taxSnapshot = { ...(order.taxSnapshot as Record<string, unknown> ?? {}), schemaVersion: 3, jurisdiction: settings.taxJurisdiction, taxConfigurationId: settings.taxConfigurationId, effectiveTaxRate: settings.taxRate, taxRate: settings.taxRate, customerTaxableTenderBase: taxableBaseCents / 100, customerTaxCollected: taxCents / 100, taxCalculated: taxCents / 100, taxCollected: taxCents / 100, tenderAllocation, tender: creditCents > 0 ? "customer_credit+paypal" : "paypal", locationId: Number.isInteger(locationId) && locationId > 0 ? locationId : null, pendingTender: false };
      await tx.update(ordersTable).set({ tax: centsToDollars(taxCents), total: centsToDollars(totalCents), remainingTenderAmount: centsToDollars(remainingCents), taxSnapshot, checkoutConversionSnapshot: finalCheckoutSnapshot, financialFinalizedAt: new Date() }).where(and(eq(ordersTable.id, order.id), eq(ordersTable.tenantId, order.tenantId)));
      const grossSalesCents = dollarsToCents(order.grossSubtotal ?? order.subtotal);
      const snapshotValues = { jurisdiction: settings.taxJurisdiction, locationId: Number.isInteger(locationId) && locationId > 0 ? locationId : null, taxConfigurationId: settings.taxConfigurationId, grossSales: centsToDollars(grossSalesCents), taxRate: String(settings.taxRate), taxableSubtotal: centsToDollars(taxableBaseCents), nonTaxableSubtotal: centsToDollars(Math.max(0, dollarsToCents(order.subtotal) - taxableBaseCents)), discountAmount: String(order.discountTotal ?? "0.00"), cashDiscountAmount: "0.00", taxCollected: centsToDollars(taxCents), taxCalculated: centsToDollars(taxCents), taxRefunded: "0.00", roundingPolicy: "round_half_away_from_zero_per_order", tender: creditCents > 0 ? "customer_credit+paypal" : "paypal", exemptionReason: null, snapshotJson: { customerTaxableTenderBaseCents: taxableBaseCents, customerTaxCollectedCents: taxCents, tenderAllocation, taxConfigurationId: settings.taxConfigurationId } };
      const [existingSnapshot] = await tx.select().from(orderTaxSnapshotsTable).where(and(eq(orderTaxSnapshotsTable.tenantId, input.tenantId), eq(orderTaxSnapshotsTable.orderId, order.id))).limit(1);
      if (existingSnapshot) {
        if (dollarsToCents(existingSnapshot.taxCollected) !== taxCents || dollarsToCents(existingSnapshot.grossSales) !== grossSalesCents || !["paypal", "paypal_card"].includes((existingSnapshot.tender ?? "").replace("customer_credit+", ""))) {
          throw new PaymentServiceError(409, "FINANCIAL_SNAPSHOT_MISMATCH", "Order tax snapshot requires reconciliation");
        }
      } else await tx.insert(orderTaxSnapshotsTable).values({ tenantId: input.tenantId, orderId: order.id, ...snapshotValues });
      const amount = centsToDollars(remainingCents);
      if (Number(amount) <= 0) throw new PaymentServiceError(409, "NO_EXTERNAL_BALANCE", "Customer Credit covers the full order; no PayPal order is permitted");
      const [attempt] = existing ? [existing] : await tx.insert(paymentAttemptsTable).values({ tenantId: input.tenantId, orderId: input.orderId, provider: "paypal", providerEnvironment: this.config.environment, idempotencyKey: input.idempotencyKey, requestedAmount: amount, requestedCurrency: CURRENCY, state: "creating" }).returning();
      let providerOrder;
      try { providerOrder = await this.provider.createOrder({ amount: { value: amount, currency: CURRENCY }, requestId: `create-${attempt.id}`, internalOrderId: input.orderId }); }
      catch (error) {
        const unknown = error instanceof PayPalProviderError && error.failureClass === "unknown_outcome";
        await tx.update(paymentAttemptsTable).set({ state: unknown ? "reconciliation_required" : "failed", reconciliationState: unknown ? "pending" : "not_required", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentAttemptsTable.id, attempt.id));
        if (!unknown) await releaseInventoryReservationsForOrder(tx, input.tenantId, order.id);
        return { providerError: error };
      }
      if (!sameMoney(providerOrder.amount.value, amount) || providerOrder.amount.currency !== CURRENCY) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "amount_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); return { providerError: new PaymentServiceError(502, "PROVIDER_AMOUNT_MISMATCH", "Provider order amount mismatch") }; }
      await tx.update(paymentAttemptsTable).set({ providerOrderId: providerOrder.id, state: "created" }).where(eq(paymentAttemptsTable.id, attempt.id));
      return { attemptId: attempt.id, providerOrderId: providerOrder.id, approvalUrl: providerOrder.approvalUrl, status: "created", replayed: false };
    });
    if ("providerError" in outcome) throw outcome.providerError;
    return outcome;
  }

  async capture(input: { tenantId: number; customerId: number; orderId: number; attemptId: number; idempotencyKey: string; finalize: (order: typeof ordersTable.$inferSelect, tx: PaymentTransaction) => Promise<void> }) {
    const outcome = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.customerId !== input.customerId) throw new PaymentServiceError(403, "ORDER_FORBIDDEN", "Forbidden");
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.id, input.attemptId), eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId))).limit(1);
      if (!attempt?.providerOrderId) throw new PaymentServiceError(409, "PAYMENT_NOT_READY", "Payment attempt is not ready");
      if (attempt.providerEnvironment !== this.config.environment) throw new PaymentServiceError(409, "PAYMENT_ENVIRONMENT_MISMATCH", "Payment attempt requires its original provider environment");
      if (["cancelled", "refunded", "voided", "archived", "completed"].includes(order.status)) throw new PaymentServiceError(409, "INVALID_ORDER_STATE", "Order cannot be captured in its current state");
      if (attempt.state === "failed") throw new PaymentServiceError(409, "PAYMENT_ATTEMPT_FAILED", "Start a new payment attempt");
      if (attempt.state === "reconciliation_required" || attempt.state === "capturing") throw new PaymentServiceError(409, "PAYMENT_RECONCILIATION_REQUIRED", "Resolve the capture outcome before retrying");
      const [existingCapture] = await tx.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, attempt.id)).limit(1);
      if (existingCapture?.state === "completed" && order.paymentStatus === "paid") return { status: "captured", captureId: existingCapture.providerCaptureId, replayed: true };
      if (order.paymentStatus === "paid") throw new PaymentServiceError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      if (!["created", "approved"].includes(attempt.state)) throw new PaymentServiceError(409, "PAYMENT_RECONCILIATION_REQUIRED", "Resolve the capture outcome before retrying");
      if (!order.financialFinalizedAt || !sameMoney(String(order.remainingTenderAmount), String(attempt.requestedAmount)) || attempt.requestedCurrency !== CURRENCY) {
        throw new PaymentServiceError(409, "FINANCIAL_SNAPSHOT_MISMATCH", "Order and payment attempt require reconciliation");
      }
      await tx.update(paymentAttemptsTable).set({ state: "capturing" }).where(eq(paymentAttemptsTable.id, attempt.id));
      let capture;
      try { capture = await this.provider.captureOrder(attempt.providerOrderId, `capture-${attempt.id}`); }
      catch (error) {
        const declined = error instanceof PayPalProviderError && error.failureClass === "declined";
        await tx.update(paymentAttemptsTable).set({ state: declined ? "failed" : "reconciliation_required", reconciliationState: declined ? "not_required" : "pending", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentAttemptsTable.id, attempt.id));
        if (declined) await releaseInventoryReservationsForOrder(tx, input.tenantId, order.id);
        return { providerError: error };
      }
      if (capture.orderId !== attempt.providerOrderId || capture.status !== "COMPLETED" || !sameMoney(capture.amount.value, attempt.requestedAmount) || capture.amount.currency !== attempt.requestedCurrency) { await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "capture_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); return { providerError: new PaymentServiceError(409, "CAPTURE_MISMATCH", "Capture requires reconciliation") }; }
      await tx.insert(paymentCapturesTable).values({ tenantId: input.tenantId, paymentAttemptId: attempt.id, provider: "paypal", providerEnvironment: this.config.environment, providerCaptureId: capture.captureId, amount: capture.amount.value, currency: capture.amount.currency, state: "completed", capturedAt: new Date() }).onConflictDoNothing();
      try {
        await tx.transaction(async finalizeTx => {
          await input.finalize(order, finalizeTx);
          const creditCents = dollarsToCents(order.customerCreditApplied);
          if (creditCents > 0) await consumeCustomerCredit(finalizeTx, { tenantId: input.tenantId, customerId: order.customerId, actorUserId: input.customerId, orderId: order.id, amountCents: creditCents, idempotencyKey: `consume:capture:${attempt.id}` });
          const tender = capture.fundingSource === "card" ? "paypal_card" : "paypal";
          const finalTender = creditCents > 0 ? `customer_credit+${tender}` : tender;
          await finalizeTx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: finalTender, selectedPaymentMethod: tender, paymentIntentId: capture.captureId,
            taxSnapshot: { ...(order.taxSnapshot as Record<string, unknown> ?? {}), tender: finalTender } }).where(and(eq(ordersTable.id, order.id), eq(ordersTable.tenantId, order.tenantId)));
          await finalizeTx.update(paymentAttemptsTable).set({ state: "captured", fundingSource: capture.fundingSource ?? "paypal", capturedAmount: capture.amount.value, capturedCurrency: capture.amount.currency, reconciliationState: "not_required" }).where(eq(paymentAttemptsTable.id, attempt.id));
        });
        return { status: "captured", captureId: capture.captureId, replayed: false };
      } catch (error) {
        await tx.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "pending", failureClass: "local_finalize_failed" }).where(eq(paymentAttemptsTable.id, attempt.id));
        return { providerError: error };
      }
    });
    if ("providerError" in outcome) throw outcome.providerError;
    return outcome;
  }

  /**
   * Commit the provider intent before the external POST.  This deliberately
   * uses its own transaction: callers must never wrap the provider call in a
   * larger local transaction whose rollback would erase the request identity.
   */
  async prepareRefund(input: { tenantId: number; orderId: number; actorUserId: number; idempotencyKey: string; amount?: string; reason: string }) {
    return db.transaction(async tx => this.prepareRefundInTransaction(tx, input));
  }

  async prepareRefundInTransaction(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], input: { tenantId: number; orderId: number; actorUserId: number; idempotencyKey: string; amount?: string; reason: string }) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId))).limit(1);
      if (!order) throw new PaymentServiceError(404, "ORDER_NOT_FOUND", "Order not found");
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId))).orderBy(sql`${paymentAttemptsTable.createdAt} DESC`).limit(1);
      if (!attempt) throw new PaymentServiceError(409, "NO_CAPTURE", "No captured PayPal payment exists");
      const [capture] = await tx.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, attempt.id)).limit(1);
      if (!capture) throw new PaymentServiceError(409, "NO_CAPTURE", "No captured PayPal payment exists");
      const completed = (await tx.select().from(paymentRefundsTable).where(eq(paymentRefundsTable.paymentCaptureId, capture.id))).filter(row => row.state === "locally_finalized" || row.state === "completed");
      const refunded = completed.reduce((sum, row) => sum + Number(row.amount), 0); const amount = Number(input.amount ?? (Number(capture.amount) - refunded).toFixed(2));
      if (!Number.isFinite(amount) || amount <= 0 || refunded + amount > Number(capture.amount)) throw new PaymentServiceError(409, "INVALID_REFUND_AMOUNT", "Refund exceeds captured amount");
      const [existing] = await tx.select().from(paymentRefundsTable).where(and(eq(paymentRefundsTable.tenantId, input.tenantId), eq(paymentRefundsTable.paymentCaptureId, capture.id), eq(paymentRefundsTable.idempotencyKey, input.idempotencyKey))).limit(1);
      if (existing && !existing.providerRequestId) throw new PaymentServiceError(409, "LOST_PROVIDER_IDENTITY", "Historical refund requires reconciliation; provider replay is forbidden");
      const [row] = existing ? [existing] : await tx.insert(paymentRefundsTable).values({ tenantId: input.tenantId, paymentCaptureId: capture.id, idempotencyKey: input.idempotencyKey, providerRequestId: `refund-${randomUUID()}`, amount: amount.toFixed(2), currency: capture.currency, reason: input.reason.slice(0, 500), actorUserId: input.actorUserId, state: "requested", requestedAt: new Date() }).returning();
      return { refundRowId: row.id, captureId: capture.providerCaptureId, amount: String(row.amount), currency: row.currency, requestId: row.providerRequestId!, reason: row.reason, state: row.state, providerRefundId: row.providerRefundId, replayed: !!existing };
  }

  async recordRefundProviderResult(input: { refundRowId: number; refund: { refundId: string; status: string; amount?: { value: string; currency: string } } }) {
    return db.transaction(async tx => {
      const [row] = await tx.select().from(paymentRefundsTable).where(eq(paymentRefundsTable.id, input.refundRowId)).limit(1);
      if (!row) throw new PaymentServiceError(404, "REFUND_NOT_FOUND", "Refund intent not found");
      // Minimum identity/status is durable before optional representation checks.
      const next = input.refund.status === "COMPLETED" ? "provider_succeeded" : input.refund.status === "PENDING" ? "pending" : input.refund.status === "FAILED" || input.refund.status === "CANCELLED" ? "failed" : "reconciliation_required";
      await tx.update(paymentRefundsTable).set({ providerRefundId: input.refund.refundId, providerStatus: input.refund.status, providerResultAt: new Date(), state: next, failureClass: null }).where(eq(paymentRefundsTable.id, row.id));
      if (input.refund.amount && (!sameMoney(input.refund.amount.value, String(row.amount)) || input.refund.amount.currency !== row.currency)) {
        await tx.update(paymentRefundsTable).set({ state: "reconciliation_required", failureClass: "refund_amount_mismatch" }).where(eq(paymentRefundsTable.id, row.id));
        throw new PaymentServiceError(409, "REFUND_AMOUNT_MISMATCH", "Provider refund requires reconciliation");
      }
      return { status: next, refundId: input.refund.refundId };
    });
  }

  async finalizeRefund(refundRowId: number) {
    return db.transaction(async tx => this.finalizeRefundInTransaction(tx, refundRowId));
  }

  async finalizeRefundInTransaction(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], refundRowId: number) {
      const [row] = await tx.select().from(paymentRefundsTable).where(eq(paymentRefundsTable.id, refundRowId)).limit(1);
      if (!row) throw new PaymentServiceError(404, "REFUND_NOT_FOUND", "Refund intent not found");
      if (row.state === "locally_finalized") return { status: "completed", refundId: row.providerRefundId, replayed: true };
      if (row.state !== "provider_succeeded" || !row.providerRefundId) throw new PaymentServiceError(409, "REFUND_NOT_READY", "Provider refund is not finalized");
      const [capture] = await tx.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.id, row.paymentCaptureId)).limit(1);
      if (!capture) throw new PaymentServiceError(409, "NO_CAPTURE", "No captured PayPal payment exists");
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(eq(paymentAttemptsTable.id, capture.paymentAttemptId)).limit(1);
      const [order] = attempt ? await tx.select().from(ordersTable).where(and(eq(ordersTable.id, attempt.orderId), eq(ordersTable.tenantId, row.tenantId))).limit(1) : [];
      if (!attempt || !order) throw new PaymentServiceError(409, "PAYMENT_NOT_READY", "Payment attempt is not ready");
      const completed = (await tx.select().from(paymentRefundsTable).where(eq(paymentRefundsTable.paymentCaptureId, capture.id))).filter(refund => refund.state === "locally_finalized" || refund.state === "completed");
      const refundedBefore = completed.reduce((sum: number, refund) => sum + Number(refund.amount), 0);
      const amount = Number(row.amount);
      {
        const fullProviderRefund = refundedBefore + amount === Number(capture.amount);
        const creditCents = Math.round(Number(order.customerCreditApplied) * 100);
        if (fullProviderRefund && creditCents > 0) await restoreCustomerCredit(tx, { tenantId: row.tenantId, customerId: order.customerId, actorUserId: row.actorUserId, orderId: order.id, amountCents: creditCents, paymentRefundId: row.id, idempotencyKey: `restore:refund:${row.id}`, reason: "Original-tender refund restoration" });
        const fullOrderRefund = fullProviderRefund;
        const [tax] = await tx.select().from(orderTaxSnapshotsTable).where(and(eq(orderTaxSnapshotsTable.tenantId, row.tenantId), eq(orderTaxSnapshotsTable.orderId, order.id))).limit(1);
        if (tax) {
          const priorTaxRefunded = Number(tax.taxRefunded); const orderTotal = Number(order.total);
          const economicRefund = amount + (fullProviderRefund ? creditCents / 100 : 0);
          const taxRefund = fullOrderRefund ? Number(tax.taxCollected) : Math.round(Number(tax.taxCollected) * economicRefund / orderTotal * 100) / 100;
          await tx.update(orderTaxSnapshotsTable).set({ taxRefunded: Math.min(Number(tax.taxCollected), priorTaxRefunded + taxRefund).toFixed(2) }).where(eq(orderTaxSnapshotsTable.id, tax.id));
        }
        await tx.update(paymentCapturesTable).set({ state: fullProviderRefund ? "refunded" : "partially_refunded" }).where(eq(paymentCapturesTable.id, capture.id));
        await tx.update(paymentAttemptsTable).set({ state: fullProviderRefund ? "refunded" : "partially_refunded" }).where(eq(paymentAttemptsTable.id, attempt.id));
        await tx.update(ordersTable).set(fullOrderRefund ? { paymentStatus: "refunded", status: "refunded" } : { paymentStatus: "partially_refunded" }).where(eq(ordersTable.id, order.id));
      }
      await tx.update(paymentRefundsTable).set({ state: "locally_finalized", locallyFinalizedAt: new Date(), failureClass: null }).where(eq(paymentRefundsTable.id, row.id));
      return { status: "completed", refundId: row.providerRefundId, replayed: false };
  }

  async refund(input: { tenantId: number; orderId: number; actorUserId: number; idempotencyKey: string; amount?: string; reason: string }) {
    const intent = await this.prepareRefund(input);
    if (intent.state === "locally_finalized") return { status: "completed", refundId: intent.providerRefundId, replayed: true };
    if (intent.state === "provider_succeeded") return this.finalizeRefund(intent.refundRowId);
    let refund;
    try { refund = await this.provider.refundCapture(intent.captureId, { value: intent.amount, currency: intent.currency }, intent.requestId, intent.reason); }
    catch (error) {
      await db.update(paymentRefundsTable).set({ state: "reconciliation_required", failureClass: error instanceof PayPalProviderError ? error.failureClass : "provider_error" }).where(eq(paymentRefundsTable.id, intent.refundRowId));
      throw error;
    }
    const recorded = await this.recordRefundProviderResult({ refundRowId: intent.refundRowId, refund });
    if (recorded.status !== "provider_succeeded") return { status: recorded.status, refundId: recorded.refundId, replayed: intent.replayed };
    const finalized = await this.finalizeRefund(intent.refundRowId);
    return { ...finalized, replayed: intent.replayed || finalized.replayed };
  }

  async reconcile(input: { tenantId: number; orderId: number; finalize: (order: typeof ordersTable.$inferSelect, tx: PaymentTransaction) => Promise<void> }) {
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
        if (order.paymentStatus !== "paid") {
          try { await input.finalize(order, tx); }
          catch (error) {
            logger.error({ orderId: order.id, failureClass: "local_finalize_failed", error: error instanceof Error ? error.message : "unknown" }, "PayPal reconciliation local finalization failed");
            throw error;
          }
        }
        await tx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "paypal_verified", selectedPaymentMethod: "paypal_verified", paymentIntentId: capture.captureId }).where(eq(ordersTable.id, order.id));
        await tx.update(paymentAttemptsTable).set({ state: "captured", capturedAmount: capture.amount.value, capturedCurrency: capture.amount.currency, reconciliationState: "resolved", failureClass: null }).where(eq(paymentAttemptsTable.id, attempt.id));
        return { localState: "captured", providerState: capture.status, recovered: order.paymentStatus !== "paid" };
      }
      const nextState = authoritative.status === "APPROVED" ? "approved" : authoritative.status === "CREATED" ? "created" : "reconciliation_required";
      if (authoritative.status === "VOIDED" && !authoritative.capture && order.paymentStatus !== "paid") {
        await tx.update(paymentAttemptsTable).set({ state: "failed", reconciliationState: "resolved", failureClass: "provider_voided" }).where(eq(paymentAttemptsTable.id, attempt.id));
        await releaseInventoryReservationsForOrder(tx, input.tenantId, order.id);
        return { localState: "failed", providerState: authoritative.status, recovered: false };
      }
      await tx.update(paymentAttemptsTable).set({ state: nextState, reconciliationState: nextState === "reconciliation_required" ? "manual_review" : "not_required" }).where(eq(paymentAttemptsTable.id, attempt.id));
      return { localState: nextState, providerState: authoritative.status, recovered: false };
    });
  }

  /** Resolve only an expired, unapproved sandbox checkout. This cannot
   * release a hold after approval or an ambiguous provider response. */
  async expireAbandonedCreated(input: { tenantId: number; orderId: number; attemptId: number; actorUserId: number }) {
    if (this.config.environment !== "sandbox") throw new PaymentServiceError(409, "SANDBOX_ONLY", "Abandoned-order expiry requires sandbox");
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
      const [actor] = await tx.select({ id: usersTable.id, tenantId: usersTable.tenantId, email: usersTable.email, role: usersTable.role }).from(usersTable).where(and(eq(usersTable.id, input.actorUserId), eq(usersTable.tenantId, input.tenantId))).limit(1);
      if (!actor || !["admin", "global_admin"].includes(actor.role)) throw new PaymentServiceError(403, "PAYMENT_FORBIDDEN", "Admin authorization required");
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId))).limit(1);
      const [attempt] = await tx.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, input.tenantId), eq(paymentAttemptsTable.orderId, input.orderId), eq(paymentAttemptsTable.id, input.attemptId))).limit(1);
      if (!order || !attempt?.providerOrderId || attempt.providerEnvironment !== this.config.environment) throw new PaymentServiceError(404, "PAYMENT_NOT_FOUND", "Payment attempt not found");
      if (attempt.state === "failed" && attempt.failureClass === "provider_created_abandoned" && order.status === "cancelled") return { status: "expired", replayed: true, reservationReleased: 0 };
      const unfulfilledPickupReady = order.status === "ready" && order.deliveryMethod === "pickup" && !order.acceptedAt && !order.preparedAt && !order.handoffCompletedAt;
      if (order.paymentStatus !== "unpaid" || attempt.state !== "created" || attempt.capturedAmount || (!["submitted", "confirmed"].includes(order.status) && !unfulfilledPickupReady)) throw new PaymentServiceError(409, "PAYMENT_RECONCILIATION_REQUIRED", "Payment is not an abandoned created checkout");
      const [capture] = await tx.select().from(paymentCapturesTable).where(and(eq(paymentCapturesTable.tenantId, input.tenantId), eq(paymentCapturesTable.paymentAttemptId, attempt.id))).limit(1);
      if (capture) throw new PaymentServiceError(409, "CAPTURE_RECONCILIATION_REQUIRED", "Captured payment cannot be expired");
      const reservations = await tx.select({ id: inventoryReservationsTable.id, expiresAt: inventoryReservationsTable.expiresAt }).from(inventoryReservationsTable).where(and(eq(inventoryReservationsTable.orderId, order.id), eq(inventoryReservationsTable.status, "reserved")));
      if (!reservations.length || reservations.some(row => row.expiresAt.getTime() > Date.now())) throw new PaymentServiceError(409, "RESERVATION_NOT_EXPIRED", "Inventory reservation is not expired");
      const authoritative = await this.provider.getOrder(attempt.providerOrderId);
      if (authoritative.id !== attempt.providerOrderId || authoritative.status !== "CREATED" || authoritative.capture || !sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) throw new PaymentServiceError(409, "PROVIDER_ORDER_NOT_ABANDONED", "Provider order requires reconciliation");
      await tx.update(paymentAttemptsTable).set({ state: "failed", reconciliationState: "resolved", failureClass: "provider_created_abandoned" }).where(and(eq(paymentAttemptsTable.id, attempt.id), eq(paymentAttemptsTable.tenantId, input.tenantId)));
      const reservationReleased = await releaseInventoryReservationsForOrder(tx, input.tenantId, order.id);
      const creditCents = dollarsToCents(order.customerCreditApplied);
      if (creditCents > 0) await releaseCustomerCredit(tx, { tenantId: input.tenantId, customerId: order.customerId, actorUserId: input.actorUserId, orderId: order.id, amountCents: creditCents, idempotencyKey: `release:abandoned:${attempt.id}`, reason: "Abandoned sandbox PayPal checkout" });
      const now = new Date();
      await tx.update(ordersTable).set({ status: "cancelled", fulfillmentStatus: "cancelled", cancelledAt: now, cancelledByUserId: input.actorUserId, customerCreditApplied: creditCents > 0 ? "0.00" : order.customerCreditApplied, remainingTenderAmount: creditCents > 0 ? order.total : order.remainingTenderAmount, updatedAt: now }).where(and(eq(ordersTable.id, order.id), eq(ordersTable.tenantId, input.tenantId)));
      await tx.insert(auditLogsTable).values({ tenantId: input.tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "PAYPAL_CREATED_ORDER_ABANDONED", resourceType: "order", resourceId: String(order.id), metadata: { attemptId: attempt.id, reservationReleased, providerState: "CREATED" } });
      return { status: "expired", replayed: false, reservationReleased };
    });
  }

  async verifyAndRecordWebhook(headers: PayPalTransmissionHeaders, event: { id: string; event_type: string; resource?: Record<string, unknown> }) {
    if (!await this.provider.verifyWebhook(headers, event)) throw new PaymentServiceError(400, "INVALID_WEBHOOK_SIGNATURE", "Invalid webhook signature");
    const allowed = new Set(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.REFUND.COMPLETED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"]);
    const environment = this.config.environment;
    const recorded = await db.insert(paymentWebhookEventsTable).values({ provider: "paypal", providerEnvironment: environment, providerEventId: event.id, eventType: event.event_type, processingState: allowed.has(event.event_type) ? "verified" : "ignored" }).onConflictDoNothing().returning();
    if (!allowed.has(event.event_type)) return { replayed: recorded.length === 0, processed: false };
    try { return await db.transaction(async tx => {
    // A delivery may race with a replay. Keep the event row, provider lookup,
    // and every local effect under one lock, and retry only unfinished rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(192837465, hashtext(${event.id}))`);
    const [row] = await tx.select().from(paymentWebhookEventsTable).where(and(
      eq(paymentWebhookEventsTable.provider, "paypal"), eq(paymentWebhookEventsTable.providerEnvironment, environment),
      eq(paymentWebhookEventsTable.providerEventId, event.id),
    )).limit(1);
    if (!row || row.eventType !== event.event_type) throw new PaymentServiceError(409, "WEBHOOK_IDENTITY_MISMATCH", "Webhook event identity mismatch");
    if (row.processingState === "processed" || row.processingState === "ignored") return { replayed: true, processed: row.processingState === "processed" };
    if (!["verified", "reconciliation_required"].includes(row.processingState)) throw new PaymentServiceError(409, "WEBHOOK_RECONCILIATION_REQUIRED", "Webhook event requires review");
    const inserted = [row];
    const db = tx;
    // The resource identifier is used only to retrieve authoritative provider
    // state. It is never trusted as the local order mapping.
    const resourceId = typeof event.resource?.id === "string" ? event.resource.id : undefined;
    if (!resourceId) { await db.update(paymentWebhookEventsTable).set({ processingState: "failed", failureClass: "missing_resource_id", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); throw new PaymentServiceError(400, "INVALID_WEBHOOK_RESOURCE", "Invalid webhook resource"); }
    if (event.event_type.startsWith("PAYMENT.REFUND.")) {
      // A verified refund event is useful only when it establishes a trusted
      // local capture relationship.  The signed payload is never allowed to
      // create a refund operation for an unknown capture.
      const links = Array.isArray(event.resource?.links) ? event.resource.links as Array<Record<string, unknown>> : [];
      const up = links.find(link => link.rel === "up" && typeof link.href === "string")?.href as string | undefined;
      const captureId = typeof (event.resource?.supplementary_data as Record<string, unknown> | undefined)?.related_ids === "object"
        ? ((event.resource?.supplementary_data as { related_ids?: { capture_id?: unknown } }).related_ids?.capture_id as string | undefined)
        : undefined;
      const linkedCaptureId = captureId ?? (up ? up.split("/").pop() : undefined);
      if (!linkedCaptureId) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", providerRefundId: resourceId, failureClass: "unlinked_refund_event", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      const [capture] = await db.select().from(paymentCapturesTable).where(and(eq(paymentCapturesTable.provider, "paypal"), eq(paymentCapturesTable.providerEnvironment, environment), eq(paymentCapturesTable.providerCaptureId, linkedCaptureId))).limit(1);
      if (!capture) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", providerCaptureId: linkedCaptureId, providerRefundId: resourceId, failureClass: "unmapped_capture", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      const amount = event.resource?.amount as { value?: unknown; currency_code?: unknown } | undefined;
      const candidates = (await db.select().from(paymentRefundsTable).where(and(eq(paymentRefundsTable.tenantId, capture.tenantId), eq(paymentRefundsTable.paymentCaptureId, capture.id)))).filter(row => ["requested", "reconciliation_required", "pending"].includes(row.state) && (!amount || (typeof amount.value === "string" && typeof amount.currency_code === "string" && sameMoney(amount.value, String(row.amount)) && amount.currency_code === row.currency)));
      if (candidates.length !== 1) { await db.update(paymentWebhookEventsTable).set({ tenantId: capture.tenantId, providerCaptureId: linkedCaptureId, providerRefundId: resourceId, processingState: "reconciliation_required", failureClass: candidates.length ? "ambiguous_refund_operation" : "unmapped_refund_operation", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      const refund = candidates[0]; const status = event.event_type === "PAYMENT.REFUND.COMPLETED" ? "COMPLETED" : event.event_type === "PAYMENT.REFUND.PENDING" ? "PENDING" : "FAILED";
      await db.update(paymentRefundsTable).set({ providerRefundId: resourceId, providerStatus: status, providerResultAt: new Date(), state: status === "COMPLETED" ? "provider_succeeded" : status === "PENDING" ? "pending" : "failed", failureClass: null }).where(eq(paymentRefundsTable.id, refund.id));
      const [attempt] = await db.select().from(paymentAttemptsTable).where(eq(paymentAttemptsTable.id, capture.paymentAttemptId)).limit(1);
      await db.update(paymentWebhookEventsTable).set({ tenantId: capture.tenantId, paymentAttemptId: attempt?.id, paymentRefundId: refund.id, providerCaptureId: linkedCaptureId, providerRefundId: resourceId, processingState: "processed", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id));
      return { replayed: false, processed: true };
    }
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
      const authoritative = await this.provider.getOrder(resourceId);
      const [attempt] = await db.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.provider, "paypal"), eq(paymentAttemptsTable.providerEnvironment, environment), eq(paymentAttemptsTable.providerOrderId, authoritative.id))).limit(1);
      if (!attempt) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", failureClass: "unmapped_provider_order", providerOrderId: authoritative.id, processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      if (!sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) throw new PaymentServiceError(409, "WEBHOOK_AMOUNT_MISMATCH", "Webhook order requires reconciliation");
      // A delayed approval must never move a captured or refunded attempt
      // backwards. Capture can complete before this webhook is delivered.
      if (attempt.state === "created") await db.update(paymentAttemptsTable).set({ state: "approved" })
        .where(and(eq(paymentAttemptsTable.id, attempt.id), eq(paymentAttemptsTable.state, "created")));
      await db.update(paymentWebhookEventsTable).set({ tenantId: attempt.tenantId, paymentAttemptId: attempt.id, providerOrderId: authoritative.id, processingState: "processed", processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id));
    } else {
      const authoritative = await this.provider.getCapture(resourceId);
      const [attempt] = await db.select().from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.provider, "paypal"), eq(paymentAttemptsTable.providerEnvironment, environment), eq(paymentAttemptsTable.providerOrderId, authoritative.orderId))).limit(1);
      if (!attempt) { await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", failureClass: "unmapped_capture", providerOrderId: authoritative.orderId, providerCaptureId: authoritative.captureId, processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id)); return { replayed: false, processed: false }; }
      if (!sameMoney(authoritative.amount.value, attempt.requestedAmount) || authoritative.amount.currency !== attempt.requestedCurrency) { await db.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "manual_review", failureClass: "webhook_amount_mismatch" }).where(eq(paymentAttemptsTable.id, attempt.id)); throw new PaymentServiceError(409, "WEBHOOK_AMOUNT_MISMATCH", "Webhook capture requires reconciliation"); }
      const alreadyFinalized = attempt.state === "captured" || attempt.state === "refunded" || attempt.state === "partially_refunded";
      if (!alreadyFinalized) await db.update(paymentAttemptsTable).set({ state: "reconciliation_required", reconciliationState: "pending", failureClass: `webhook_${event.event_type.toLowerCase().replaceAll(".", "_")}` }).where(eq(paymentAttemptsTable.id, attempt.id));
      const [localCapture] = await db.select().from(paymentCapturesTable).where(and(eq(paymentCapturesTable.tenantId, attempt.tenantId), eq(paymentCapturesTable.providerCaptureId, authoritative.captureId))).limit(1);
      const pendingRefunds = localCapture ? (await db.select().from(paymentRefundsTable).where(and(eq(paymentRefundsTable.tenantId, attempt.tenantId), eq(paymentRefundsTable.paymentCaptureId, localCapture.id)))).filter(refund => ["requested", "reconciliation_required"].includes(refund.state)) : [];
      if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" && pendingRefunds.length === 1) await db.update(paymentRefundsTable).set({ state: "reconciliation_required", failureClass: "capture_refunded_without_refund_identity" }).where(eq(paymentRefundsTable.id, pendingRefunds[0].id));
      await db.update(paymentWebhookEventsTable).set({ tenantId: attempt.tenantId, paymentAttemptId: attempt.id, providerOrderId: authoritative.orderId, providerCaptureId: authoritative.captureId, processingState: event.event_type === "PAYMENT.CAPTURE.REFUNDED" ? "reconciliation_required" : "processed", failureClass: event.event_type === "PAYMENT.CAPTURE.REFUNDED" ? "capture_refunded_without_refund_identity" : null, processedAt: new Date() }).where(eq(paymentWebhookEventsTable.id, inserted[0].id));
    }
    return { replayed: recorded.length === 0, processed: true };
    }); } catch (error) {
      // Preserve a verified event even when authoritative provider lookup or
      // local processing fails. A later signed delivery may safely retry it.
      await db.update(paymentWebhookEventsTable).set({ processingState: "reconciliation_required", failureClass: error instanceof PayPalProviderError ? "provider_lookup_failed" : "processing_failed", processedAt: new Date() })
        .where(and(eq(paymentWebhookEventsTable.provider, "paypal"), eq(paymentWebhookEventsTable.providerEnvironment, environment), eq(paymentWebhookEventsTable.providerEventId, event.id), inArray(paymentWebhookEventsTable.processingState, ["verified", "reconciliation_required"])));
      throw error;
    }
  }
}
