import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, ordersTable, paymentAttemptsTable } from "@workspace/db";
import { z } from "zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { requireCurrentCustomerDisclaimerAcceptance } from "../lib/customerDisclaimerEnforcement";
import { reserveCustomerCredit, consumeCustomerCredit, CustomerCreditError } from "../payments/customerCredit";
import { deductPaidOrderInventory } from "../payments/inventory";
import { centsToDollars, dollarsToCents } from "../lib/tenderTax";

export { deductPaidOrderInventory } from "../payments/inventory";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

// Compatibility endpoints are intentionally retired. They cannot create mock
// identifiers, contact Stripe, or alter an order.
router.post("/payments/tokenize", (_req, res) => res.status(410).json({ error: "PAYMENT_PROVIDER_RETIRED", provider: "stripe" }));
router.post("/payments/:orderId/confirm", (_req, res) => res.status(410).json({ error: "PAYMENT_PROVIDER_RETIRED", provider: "stripe" }));

router.post("/payments/:orderId/apply-credit", requireCurrentCustomerDisclaimerAcceptance("payments.apply_credit"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = Number(req.params.orderId);
  const parsed = z.object({ amount: z.number().finite().nonnegative().refine(value => /^\d+(?:\.\d{1,2})?$/.test(String(value)), "Customer Credit must use whole cents") }).strict().safeParse(req.body);
  const idempotencyKey = req.get("Idempotency-Key");
  if (!Number.isInteger(orderId) || orderId <= 0 || !parsed.success || !idempotencyKey || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "INVALID_CUSTOMER_CREDIT_REQUEST" }); return;
  }
  const amountCents = dollarsToCents(parsed.data.amount);
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${actor.tenantId!}, ${orderId})`);
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, orderId), eq(ordersTable.customerId, actor.id))).limit(1);
      if (!order) throw new CustomerCreditError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.paymentStatus === "paid") throw new CustomerCreditError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      const [attempt] = await tx.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(and(eq(paymentAttemptsTable.tenantId, actor.tenantId!), eq(paymentAttemptsTable.orderId, orderId))).limit(1);
      if (attempt) throw new CustomerCreditError(409, "PAYMENT_ATTEMPT_EXISTS", "Customer Credit cannot change after a provider payment attempt");
      const previouslyAppliedCents = dollarsToCents(order.customerCreditApplied);
      const reserved = await reserveCustomerCredit(tx, { tenantId: actor.tenantId!, customerId: actor.id, actorUserId: actor.id, orderId, amountCents, idempotencyKey: `reserve:${idempotencyKey}` });
      if (reserved.idempotent) return { appliedCents: reserved.appliedCents, remainingCents: dollarsToCents(order.remainingTenderAmount ?? order.total), remainingCreditCents: dollarsToCents(reserved.account.balance) - dollarsToCents(reserved.account.reservedBalance), paid: false, replayed: true };
      const totalCreditCents = previouslyAppliedCents + reserved.appliedCents;
      if (totalCreditCents > dollarsToCents(order.subtotal)) throw new CustomerCreditError(409, "CREDIT_OVER_APPLICATION", "Customer Credit exceeds merchandise subtotal");
      const remainingCents = dollarsToCents(order.total) - totalCreditCents;
      if (remainingCents === 0) {
        await deductPaidOrderInventory({ ...order, selectedPaymentMethod: "customer_credit" }, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip }, tx);
        const consumed = await consumeCustomerCredit(tx, { tenantId: actor.tenantId!, customerId: actor.id, actorUserId: actor.id, orderId, amountCents: totalCreditCents, idempotencyKey: `consume:${idempotencyKey}` });
        await tx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "customer_credit", selectedPaymentMethod: "customer_credit", remainingTenderAmount: "0.00" }).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, orderId)));
        return { appliedCents: reserved.appliedCents, remainingCents, remainingCreditCents: dollarsToCents(consumed.account.balance), paid: true, replayed: reserved.idempotent };
      }
      return { appliedCents: reserved.appliedCents, remainingCents, remainingCreditCents: dollarsToCents(reserved.account.balance) - dollarsToCents(reserved.account.reservedBalance), paid: false, replayed: reserved.idempotent };
    });
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: result.replayed ? "customer_credit.reservation_replayed" : "customer_credit.reserved", tenantId: actor.tenantId!, resourceType: "order", resourceId: String(orderId), metadata: { applied: centsToDollars(result.appliedCents), remainingTender: centsToDollars(result.remainingCents) }, ipAddress: req.ip });
    res.json({ orderId, applied: result.appliedCents / 100, remainingTotal: result.remainingCents / 100, remainingBalance: result.remainingCreditCents / 100, paymentStatus: result.paid ? "paid" : "unpaid", replayed: result.replayed });
  } catch (error) {
    const known = error as { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.code ?? "CUSTOMER_CREDIT_ERROR" });
  }
});

export default router;
