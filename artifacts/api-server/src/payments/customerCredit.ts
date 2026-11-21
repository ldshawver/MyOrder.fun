import { and, eq, sql } from "drizzle-orm";
import { db, customerCreditAccountsTable, customerCreditLedgerTable, ordersTable } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CustomerCreditError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "CustomerCreditError"; }
}

const cents = (value: unknown): number => Math.round(Number(value ?? 0) * 100);
const money = (value: number): string => (value / 100).toFixed(2);

async function lockedAccount(tx: Tx, tenantId: number, customerId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${customerId})`);
  await tx.insert(customerCreditAccountsTable).values({ tenantId, customerId }).onConflictDoNothing();
  const [account] = await tx.select().from(customerCreditAccountsTable).where(and(
    eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId),
  )).limit(1);
  if (!account) throw new CustomerCreditError(500, "CREDIT_ACCOUNT_UNAVAILABLE", "Customer Credit account is unavailable");
  return account;
}

export async function getCustomerCreditBalance(tx: Tx, tenantId: number, customerId: number) {
  const account = await lockedAccount(tx, tenantId, customerId);
  return { balance: cents(account.balance), reserved: cents(account.reservedBalance), available: cents(account.balance) - cents(account.reservedBalance) };
}

export async function adjustCustomerCredit(tx: Tx, input: { tenantId: number; customerId: number; actorUserId: number; amountCents: number; reason: string; idempotencyKey: string }) {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new CustomerCreditError(400, "INVALID_CREDIT_AMOUNT", "Customer Credit adjustment must be a non-zero cent amount");
  if (!input.reason.trim()) throw new CustomerCreditError(400, "CREDIT_REASON_REQUIRED", "A reason is required");
  const account = await lockedAccount(tx, input.tenantId, input.customerId);
  const [existing] = await tx.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, input.tenantId), eq(customerCreditLedgerTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) return { account, entry: existing, idempotent: true };
  const next = cents(account.balance) + input.amountCents;
  if (next < cents(account.reservedBalance)) throw new CustomerCreditError(409, "CREDIT_NEGATIVE_BALANCE", "Adjustment would reduce Customer Credit below its reserved amount");
  const [updated] = await tx.update(customerCreditAccountsTable).set({ balance: money(next) }).where(and(eq(customerCreditAccountsTable.tenantId, input.tenantId), eq(customerCreditAccountsTable.id, account.id))).returning();
  const [entry] = await tx.insert(customerCreditLedgerTable).values({ tenantId: input.tenantId, accountId: account.id, customerId: input.customerId, entryType: "administrative_adjustment", amount: money(input.amountCents), reason: input.reason.trim(), actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey }).returning();
  return { account: updated, entry, idempotent: false };
}

export async function reserveCustomerCredit(tx: Tx, input: { tenantId: number; customerId: number; actorUserId: number; orderId: number; amountCents: number; idempotencyKey: string }) {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new CustomerCreditError(400, "INVALID_CREDIT_AMOUNT", "Customer Credit must be a non-negative cent amount");
  const account = await lockedAccount(tx, input.tenantId, input.customerId);
  const [existing] = await tx.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, input.tenantId), eq(customerCreditLedgerTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) return { account, entry: existing, appliedCents: Math.abs(cents(existing.amount)), idempotent: true };
  if (input.amountCents === 0) return { account, entry: null, appliedCents: 0, idempotent: true };
  const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId), eq(ordersTable.customerId, input.customerId))).limit(1);
  if (!order) throw new CustomerCreditError(404, "ORDER_NOT_FOUND", "Order not found");
  const unpaid = cents(order.total) - cents(order.customerCreditApplied);
  const available = cents(account.balance) - cents(account.reservedBalance);
  if (input.amountCents > unpaid) throw new CustomerCreditError(409, "CREDIT_OVER_APPLICATION", "Customer Credit exceeds the tax-inclusive unpaid balance");
  if (input.amountCents > available) throw new CustomerCreditError(409, "INSUFFICIENT_CUSTOMER_CREDIT", "Insufficient Customer Credit");
  const [updated] = await tx.update(customerCreditAccountsTable).set({ reservedBalance: money(cents(account.reservedBalance) + input.amountCents) }).where(and(eq(customerCreditAccountsTable.tenantId, input.tenantId), eq(customerCreditAccountsTable.id, account.id))).returning();
  const [entry] = await tx.insert(customerCreditLedgerTable).values({ tenantId: input.tenantId, accountId: account.id, customerId: input.customerId, entryType: "order_reservation", amount: money(-input.amountCents), reason: "Reserved for checkout", actorUserId: input.actorUserId, orderId: input.orderId, idempotencyKey: input.idempotencyKey }).returning();
  await tx.update(ordersTable).set({ customerCreditApplied: money(cents(order.customerCreditApplied) + input.amountCents), remainingTenderAmount: money(unpaid - input.amountCents) }).where(and(eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, input.orderId)));
  return { account: updated, entry, appliedCents: input.amountCents, idempotent: false };
}

export async function consumeCustomerCredit(tx: Tx, input: { tenantId: number; customerId: number; actorUserId: number; orderId: number; amountCents: number; idempotencyKey: string }) {
  const account = await lockedAccount(tx, input.tenantId, input.customerId);
  const [existing] = await tx.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, input.tenantId), eq(customerCreditLedgerTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) return { account, entry: existing, idempotent: true };
  if (input.amountCents <= 0 || input.amountCents > cents(account.reservedBalance) || input.amountCents > cents(account.balance)) throw new CustomerCreditError(409, "CREDIT_RESERVATION_MISMATCH", "Customer Credit reservation cannot be consumed");
  const [updated] = await tx.update(customerCreditAccountsTable).set({ balance: money(cents(account.balance) - input.amountCents), reservedBalance: money(cents(account.reservedBalance) - input.amountCents) }).where(and(eq(customerCreditAccountsTable.tenantId, input.tenantId), eq(customerCreditAccountsTable.id, account.id))).returning();
  const [entry] = await tx.insert(customerCreditLedgerTable).values({ tenantId: input.tenantId, accountId: account.id, customerId: input.customerId, entryType: "payment_consumption", amount: money(-input.amountCents), reason: "Consumed by finalized payment", actorUserId: input.actorUserId, orderId: input.orderId, idempotencyKey: input.idempotencyKey }).returning();
  return { account: updated, entry, idempotent: false };
}

export async function releaseCustomerCredit(tx: Tx, input: { tenantId: number; customerId: number; actorUserId: number; orderId: number; amountCents: number; idempotencyKey: string; reason: string }) {
  const account = await lockedAccount(tx, input.tenantId, input.customerId);
  const [existing] = await tx.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, input.tenantId), eq(customerCreditLedgerTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) return { account, entry: existing, idempotent: true };
  if (input.amountCents <= 0 || input.amountCents > cents(account.reservedBalance)) throw new CustomerCreditError(409, "CREDIT_RESERVATION_MISMATCH", "Customer Credit reservation cannot be released");
  const [updated] = await tx.update(customerCreditAccountsTable).set({ reservedBalance: money(cents(account.reservedBalance) - input.amountCents) }).where(and(eq(customerCreditAccountsTable.tenantId, input.tenantId), eq(customerCreditAccountsTable.id, account.id))).returning();
  const [entry] = await tx.insert(customerCreditLedgerTable).values({ tenantId: input.tenantId, accountId: account.id, customerId: input.customerId, entryType: "reservation_release", amount: money(input.amountCents), reason: input.reason, actorUserId: input.actorUserId, orderId: input.orderId, idempotencyKey: input.idempotencyKey }).returning();
  return { account: updated, entry, idempotent: false };
}

export async function restoreCustomerCredit(tx: Tx, input: { tenantId: number; customerId: number; actorUserId: number; orderId: number; amountCents: number; paymentRefundId?: number; idempotencyKey: string; reason: string }) {
  if (input.amountCents <= 0) throw new CustomerCreditError(400, "INVALID_CREDIT_AMOUNT", "Customer Credit restoration must be positive");
  const account = await lockedAccount(tx, input.tenantId, input.customerId);
  const [existing] = await tx.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, input.tenantId), eq(customerCreditLedgerTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing) return { account, entry: existing, idempotent: true };
  const [updated] = await tx.update(customerCreditAccountsTable).set({ balance: money(cents(account.balance) + input.amountCents) }).where(and(eq(customerCreditAccountsTable.tenantId, input.tenantId), eq(customerCreditAccountsTable.id, account.id))).returning();
  const [entry] = await tx.insert(customerCreditLedgerTable).values({ tenantId: input.tenantId, accountId: account.id, customerId: input.customerId, entryType: "refund_restoration", amount: money(input.amountCents), reason: input.reason, actorUserId: input.actorUserId, orderId: input.orderId, paymentRefundId: input.paymentRefundId, idempotencyKey: input.idempotencyKey }).returning();
  return { account: updated, entry, idempotent: false };
}
