import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, ordersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { requireCurrentCustomerDisclaimerAcceptance } from "../lib/customerDisclaimerEnforcement";
import { reserveCustomerCredit, consumeCustomerCredit, CustomerCreditError } from "../payments/customerCredit";
import { deductPaidOrderInventory } from "../payments/inventory";

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
  const amount = Number(req.body?.amount);
  const idempotencyKey = req.get("Idempotency-Key");
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isFinite(amount) || amount < 0 || !idempotencyKey || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "INVALID_CUSTOMER_CREDIT_REQUEST" }); return;
  }
  const amountCents = Math.round(amount * 100);
  try {
    const result = await db.transaction(async tx => {
      const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, orderId), eq(ordersTable.customerId, actor.id))).limit(1);
      if (!order) throw new CustomerCreditError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.paymentStatus === "paid") throw new CustomerCreditError(409, "ORDER_ALREADY_PAID", "Order is already paid");
      const reserved = await reserveCustomerCredit(tx, { tenantId: actor.tenantId!, customerId: actor.id, actorUserId: actor.id, orderId, amountCents, idempotencyKey: `reserve:${idempotencyKey}` });
      const remainingCents = Math.round(Number(order.total) * 100) - Math.round(Number(order.customerCreditApplied) * 100) - reserved.appliedCents;
      if (remainingCents === 0) {
        await deductPaidOrderInventory(order, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: req.ip });
        const consumed = await consumeCustomerCredit(tx, { tenantId: actor.tenantId!, customerId: actor.id, actorUserId: actor.id, orderId, amountCents: reserved.appliedCents, idempotencyKey: `consume:${idempotencyKey}` });
        await tx.update(ordersTable).set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "customer_credit", selectedPaymentMethod: "customer_credit", remainingTenderAmount: "0.00" }).where(and(eq(ordersTable.tenantId, actor.tenantId!), eq(ordersTable.id, orderId)));
        return { appliedCents: reserved.appliedCents, remainingCents, remainingCreditCents: Math.round(Number(consumed.account.balance) * 100), paid: true, replayed: reserved.idempotent };
      }
      return { appliedCents: reserved.appliedCents, remainingCents, remainingCreditCents: Math.round((Number(reserved.account.balance) - Number(reserved.account.reservedBalance)) * 100), paid: false, replayed: reserved.idempotent };
    });
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: result.replayed ? "customer_credit.reservation_replayed" : "customer_credit.reserved", tenantId: actor.tenantId!, resourceType: "order", resourceId: String(orderId), metadata: { applied: (result.appliedCents / 100).toFixed(2), remainingTender: (result.remainingCents / 100).toFixed(2) }, ipAddress: req.ip });
    res.json({ orderId, applied: result.appliedCents / 100, remainingTotal: result.remainingCents / 100, remainingBalance: result.remainingCreditCents / 100, paymentStatus: result.paid ? "paid" : "unpaid", replayed: result.replayed });
  } catch (error) {
    const known = error as { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.code ?? "CUSTOMER_CREDIT_ERROR" });
  }
});

export default router;
