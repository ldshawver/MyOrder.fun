import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { customerCreditAccountsTable, customerCreditLedgerTable, db, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { adjustCustomerCredit, CustomerCreditError, getCustomerCreditBalance } from "../payments/customerCredit";

const router: IRouter = Router();
const auth = [requireAuth, loadDbUser, requireDbUser, requireApproved] as const;

router.get("/credits/me", ...auth, async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const result = await db.transaction(async tx => {
    const balance = await getCustomerCreditBalance(tx, actor.tenantId!, actor.id);
    const [account] = await tx.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, actor.tenantId!), eq(customerCreditAccountsTable.customerId, actor.id))).limit(1);
    const entries = account ? await tx.select({ id: customerCreditLedgerTable.id, entryType: customerCreditLedgerTable.entryType, amount: customerCreditLedgerTable.amount, reason: customerCreditLedgerTable.reason, createdAt: customerCreditLedgerTable.createdAt }).from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, actor.tenantId!), eq(customerCreditLedgerTable.accountId, account.id))).orderBy(desc(customerCreditLedgerTable.createdAt)).limit(100) : [];
    return { balance, entries };
  });
  res.json({ balance: result.balance.balance / 100, reservedBalance: result.balance.reserved / 100, availableBalance: result.balance.available / 100, entries: result.entries.map(row => ({ ...row, amount: Number(row.amount) })) });
});

router.get("/admin/credits", ...auth, requirePermission("billing.manage"), async (req, res): Promise<void> => {
  const tenantId = req.dbUser!.tenantId!;
  const users = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, status: usersTable.status, balance: customerCreditAccountsTable.balance, reservedBalance: customerCreditAccountsTable.reservedBalance }).from(usersTable).leftJoin(customerCreditAccountsTable, and(eq(customerCreditAccountsTable.tenantId, usersTable.tenantId), eq(customerCreditAccountsTable.customerId, usersTable.id))).where(eq(usersTable.tenantId, tenantId));
  res.json({ users: users.map(user => ({ ...user, balance: Number(user.balance ?? 0), reservedBalance: Number(user.reservedBalance ?? 0), availableBalance: Number(user.balance ?? 0) - Number(user.reservedBalance ?? 0) })) });
});

router.post("/admin/credits", ...auth, requirePermission("billing.manage"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const customerId = Number(req.body?.userId);
  const amount = Number(req.body?.amount);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const requestedKey = req.get("Idempotency-Key");
  if (!Number.isInteger(customerId) || customerId <= 0 || !Number.isFinite(amount) || amount === 0 || !reason || (requestedKey && !/^[A-Za-z0-9._:-]{8,120}$/.test(requestedKey))) { res.status(400).json({ error: "INVALID_CUSTOMER_CREDIT_ADJUSTMENT" }); return; }
  const [target] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.tenantId, actor.tenantId!), eq(usersTable.id, customerId))).limit(1);
  if (!target) { res.status(404).json({ error: "CUSTOMER_NOT_FOUND" }); return; }
  try {
    const key = requestedKey ?? `admin:${actor.id}:${crypto.randomUUID()}`;
    const result = await db.transaction(tx => adjustCustomerCredit(tx, { tenantId: actor.tenantId!, customerId, actorUserId: actor.id, amountCents: Math.round(amount * 100), reason, idempotencyKey: key }));
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "customer_credit.administrative_adjustment", tenantId: actor.tenantId!, resourceType: "customer_credit_account", resourceId: String(result.account.id), metadata: { amount: (Math.round(amount * 100) / 100).toFixed(2), reason, replayed: result.idempotent } });
    res.status(result.idempotent ? 200 : 201).json({ id: result.entry.id, userId: customerId, amount: Number(result.entry.amount), reason: result.entry.reason, balance: Number(result.account.balance), replayed: result.idempotent, createdAt: result.entry.createdAt });
  } catch (error) {
    const known = error as CustomerCreditError;
    res.status(known.status ?? 500).json({ error: known.code ?? "CUSTOMER_CREDIT_ERROR" });
  }
});

export default router;
