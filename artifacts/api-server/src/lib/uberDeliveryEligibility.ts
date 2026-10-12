import { and, eq, sql } from "drizzle-orm";
import { cashLedgerEntriesTable, db, paymentAttemptsTable, paymentCapturesTable, paymentRefundsTable } from "@workspace/db";
import { dollarsToCents } from "./tenderTax";

type PayableOrder = { id: number; tenantId: number; paymentStatus: string; paymentMethod: string | null; total: string; customerCreditApplied: string };

/** Delivery requires actual settled tender, not a client total or a status flag alone. */
export async function isUberDeliveryFullySettled(order: PayableOrder): Promise<boolean> {
  if (order.paymentStatus !== "paid") return false;
  const total = dollarsToCents(order.total);
  const credit = dollarsToCents(order.customerCreditApplied);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(credit) || credit < 0 || credit > total) return false;
  const method = order.paymentMethod ?? "";
  if (method.includes("paypal")) {
    const [capture] = await db.select({ amount: sql<string>`coalesce(sum(${paymentCapturesTable.amount}), 0)` })
      .from(paymentCapturesTable).innerJoin(paymentAttemptsTable, and(eq(paymentCapturesTable.tenantId, paymentAttemptsTable.tenantId), eq(paymentCapturesTable.paymentAttemptId, paymentAttemptsTable.id)))
      .where(and(eq(paymentAttemptsTable.tenantId, order.tenantId), eq(paymentAttemptsTable.orderId, order.id), eq(paymentCapturesTable.state, "completed"), eq(paymentCapturesTable.currency, "USD")));
    const [refund] = await db.select({ amount: sql<string>`coalesce(sum(${paymentRefundsTable.amount}), 0)` })
      .from(paymentRefundsTable).innerJoin(paymentCapturesTable, and(eq(paymentRefundsTable.tenantId, paymentCapturesTable.tenantId), eq(paymentRefundsTable.paymentCaptureId, paymentCapturesTable.id)))
      .innerJoin(paymentAttemptsTable, and(eq(paymentCapturesTable.tenantId, paymentAttemptsTable.tenantId), eq(paymentCapturesTable.paymentAttemptId, paymentAttemptsTable.id)))
      .where(and(eq(paymentAttemptsTable.tenantId, order.tenantId), eq(paymentAttemptsTable.orderId, order.id), eq(paymentRefundsTable.state, "completed"), eq(paymentRefundsTable.currency, "USD")));
    return credit + dollarsToCents(capture?.amount ?? "0") - dollarsToCents(refund?.amount ?? "0") === total;
  }
  if (method.includes("cash")) {
    const [cash] = await db.select({ amount: sql<string>`coalesce(sum(${cashLedgerEntriesTable.amount}), 0)` })
      .from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, order.tenantId), eq(cashLedgerEntriesTable.orderId, order.id), eq(cashLedgerEntriesTable.entryType, "cash_sale_closeout")));
    return credit + dollarsToCents(cash?.amount ?? "0") === total;
  }
  return method === "customer_credit" && credit === total;
}
