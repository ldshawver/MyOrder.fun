import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, userCreditsTable, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();

let creditSchemaEnsured = false;

async function ensureCreditSchema(): Promise<void> {
  if (creditSchemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_credits" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "user_id" integer NOT NULL REFERENCES "users"("id"),
      "amount" numeric(10, 2) NOT NULL,
      "reason" text,
      "source" text NOT NULL DEFAULT 'admin_adjustment',
      "created_by" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  creditSchemaEnsured = true;
}

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function balanceFor(entries: Array<typeof userCreditsTable.$inferSelect>): number {
  return entries.reduce((sum, entry) => sum + money(entry.amount), 0);
}

// Auth chain for admin routes (requireApproved is redundant for staff roles
// but kept for belt-and-suspenders; requireRole enforces the real gate).
const adminAuthChain = [requireAuth, loadDbUser, requireDbUser, requireApproved] as const;

// Self-view only requires an authenticated DB user — no approval status check.
// Customers who receive credit before their account is explicitly "approved"
// must still be able to see their own balance.
const selfAuthChain = [requireAuth, loadDbUser, requireDbUser] as const;

router.get("/credits/me", ...selfAuthChain, async (req, res): Promise<void> => {
  await ensureCreditSchema();
  const user = req.dbUser!;
  const entries = await db
    .select()
    .from(userCreditsTable)
    .where(eq(userCreditsTable.userId, user.id))
    .orderBy(desc(userCreditsTable.createdAt));

  res.json({
    balance: balanceFor(entries),
    entries: entries.map((entry) => ({
      id: entry.id,
      amount: money(entry.amount),
      reason: entry.reason,
      source: entry.source,
      createdAt: entry.createdAt,
    })),
  });
});

router.get("/admin/credits", ...adminAuthChain, requireRole("global_admin", "admin"), async (_req, res): Promise<void> => {
  await ensureCreditSchema();
  const [users, credits] = await Promise.all([
    db.select().from(usersTable).orderBy(usersTable.createdAt),
    db.select().from(userCreditsTable).orderBy(desc(userCreditsTable.createdAt)),
  ]);

  const byUser = new Map<number, Array<typeof userCreditsTable.$inferSelect>>();
  for (const credit of credits) {
    const list = byUser.get(credit.userId) ?? [];
    list.push(credit);
    byUser.set(credit.userId, list);
  }

  res.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      balance: balanceFor(byUser.get(user.id) ?? []),
      lastCreditAt: byUser.get(user.id)?.[0]?.createdAt ?? null,
    })),
  });
});

// GET /api/admin/credits/:userId — admin/global_admin view of a single user's credit
router.get("/admin/credits/:userId", ...adminAuthChain, requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  await ensureCreditSchema();
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    res.status(400).json({ error: "userId must be a positive integer" });
    return;
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const entries = await db
    .select()
    .from(userCreditsTable)
    .where(eq(userCreditsTable.userId, targetId))
    .orderBy(desc(userCreditsTable.createdAt));

  res.json({
    userId: targetId,
    balance: balanceFor(entries),
    entries: entries.map((entry) => ({
      id: entry.id,
      amount: money(entry.amount),
      reason: entry.reason,
      source: entry.source,
      createdAt: entry.createdAt,
    })),
  });
});

router.post("/admin/credits", ...adminAuthChain, requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  await ensureCreditSchema();
  const actor = req.dbUser!;
  const userId = Number(req.body?.userId);
  const amount = Number(req.body?.amount);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "userId must be a positive integer" });
    return;
  }
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10000) {
    res.status(400).json({ error: "amount must be a non-zero number up to 10000" });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tenantId = target.tenantId ?? await getHouseTenantId();
  const [created] = await db.insert(userCreditsTable).values({
    tenantId,
    userId,
    amount: amount.toFixed(2),
    reason: reason || null,
    source: "admin_adjustment",
    createdBy: actor.id,
  }).returning();

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: amount > 0 ? "GRANT_USER_CREDIT" : "DEBIT_USER_CREDIT",
    tenantId,
    resourceType: "user",
    resourceId: String(userId),
    metadata: { amount, reason },
  });

  res.status(201).json({
    id: created.id,
    userId,
    amount: money(created.amount),
    reason: created.reason,
    createdAt: created.createdAt,
  });
});

export default router;
