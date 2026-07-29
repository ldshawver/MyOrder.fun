import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  auditLogsTable, cashLedgerEntriesTable, csrBoxesTable, db,
  generalQueueCashSessionParticipantsTable, generalQueueCashSessionsTable,
  inventoryLocationsTable, labTechShiftsTable, ordersTable, shiftRoutingConfigTable, usersTable,
} from "@workspace/db";
import { isShiftOrderRoutable } from "../lib/orderRouting";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, normalizeRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { requirePermission } from "../lib/roles";

const router: IRouter = Router();
const QUEUE_ORDER_STATUSES = ["submitted", "in_progress", "preparing", "ready", "pending", "processing"];
const supervisorRoles = new Set(["supervisor", "admin", "global_admin"]);

async function currentGeneralQueueSession(tenantId: number) {
  const [session] = await db.select().from(generalQueueCashSessionsTable)
    .where(and(eq(generalQueueCashSessionsTable.tenantId, tenantId), eq(generalQueueCashSessionsTable.status, "open")))
    .orderBy(desc(generalQueueCashSessionsTable.openedAt)).limit(1);
  return session ?? null;
}

let orderLifecycleSchemaEnsured = false;

async function ensureOrderLifecycleSchema(): Promise<void> {
  if (orderLifecycleSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz`,
    sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_by_user_id" integer REFERENCES "users"("id")`,
    sql`CREATE INDEX IF NOT EXISTS "orders_archived_at_idx" ON "orders" ("archived_at")`,
    sql`CREATE INDEX IF NOT EXISTS "orders_voided_at_idx" ON "orders" ("voided_at")`,
    sql`CREATE INDEX IF NOT EXISTS "orders_cancelled_at_idx" ON "orders" ("cancelled_at")`,
    sql`CREATE INDEX IF NOT EXISTS "orders_completed_at_idx" ON "orders" ("completed_at")`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  orderLifecycleSchemaEnsured = true;
}

router.use(async (_req, res, next) => {
  try {
    await ensureOrderLifecycleSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare order lifecycle schema" });
  }
});

router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

async function activeCsrShifts(tenantId: number) {
  return db.select({
    id: labTechShiftsTable.id,
    tenantId: labTechShiftsTable.tenantId,
    techId: labTechShiftsTable.techId,
    clockedInAt: labTechShiftsTable.clockedInAt,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
  }).from(labTechShiftsTable)
    .innerJoin(usersTable, eq(labTechShiftsTable.techId, usersTable.id))
    .where(and(
      eq(labTechShiftsTable.tenantId, tenantId),
      eq(labTechShiftsTable.status, "active"),
      sql`lower(${usersTable.role}) = 'csr'`,
    ))
    .orderBy(desc(labTechShiftsTable.clockedInAt));
}

async function latestRoutingConfig(tenantId: number) {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "shift_routing_config" (
    "id" serial PRIMARY KEY,
    "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
    "allow_multiple_active_shifts" boolean NOT NULL DEFAULT false,
    "routing_strategy" text NOT NULL DEFAULT 'round_robin',
    "approved_by_user_id" integer REFERENCES "users"("id"),
    "approved_at" timestamp with time zone,
    "reason" text DEFAULT 'default system fallback',
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "allow_multiple_active_shifts" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "routing_strategy" text NOT NULL DEFAULT 'round_robin'`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "approved_by_user_id" integer REFERENCES "users"("id")`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "reason" text DEFAULT 'default system fallback'`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "shift_routing_config_tenant_idx" ON "shift_routing_config" ("tenant_id")`);
  const [config] = await db.select().from(shiftRoutingConfigTable)
    .where(eq(shiftRoutingConfigTable.tenantId, tenantId))
    .orderBy(sql`${shiftRoutingConfigTable.approvedAt} DESC NULLS LAST`, desc(shiftRoutingConfigTable.createdAt))
    .limit(1);
  return config ?? null;
}

router.get("/shift-queue/status", requirePermission("queue.view"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const shifts = await activeCsrShifts(tenantId);
  const config = await latestRoutingConfig(tenantId);
  const activeShift = shifts[0] ?? null;
  const activeDurationSeconds = activeShift ? Math.max(0, Math.floor((Date.now() - new Date(activeShift.clockedInAt).getTime()) / 1000)) : 0;
  const activeOrders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, QUEUE_ORDER_STATUSES)));
  const defaultQueueCount = activeOrders.filter(o => o.routedTo === "default_queue" || (!o.assignedShiftId && !o.assignedCsrUserId)).length;
  const multiple = shifts.length > 1;
  const approved = config?.allowMultipleActiveShifts === true && !!config.routingStrategy;
  const generalQueueSession = await currentGeneralQueueSession(tenantId);
  let health: "green" | "yellow" = "green";
  let message = activeShift ? `Orders are routing to active CSR: ${`${activeShift.firstName ?? ""} ${activeShift.lastName ?? ""}`.trim() || activeShift.email}. Shift active for ${Math.floor(activeDurationSeconds / 3600)}h ${Math.floor((activeDurationSeconds % 3600) / 60)}m.` : "General Queue Active";
  if (!activeShift) health = "yellow";
  if (multiple && !approved) {
    health = "yellow";
    message = "Multiple active CSR shifts detected but no routing strategy is configured.";
  }
  res.json({
    health,
    message,
    activeShift,
    activeDurationSeconds,
    activeCsr: activeShift ? { id: activeShift.techId, firstName: activeShift.firstName, lastName: activeShift.lastName, email: activeShift.email } : null,
    generalQueueSession: generalQueueSession ? { id: generalQueueSession.id, status: generalQueueSession.status, openedAt: generalQueueSession.openedAt, locationId: generalQueueSession.locationId, registerBoxId: generalQueueSession.registerBoxId } : null,
    multipleActiveShifts: multiple,
    multipleActiveShiftsApproved: approved,
    routingStrategy: config?.routingStrategy ?? (activeShift ? "active_csr" : "default_queue"),
    queueCounts: { queued: activeOrders.length, defaultQueue: defaultQueueCount, assigned: activeOrders.length - defaultQueueCount },
  });
});

router.get("/shift-queue/orders", requirePermission("queue.view"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const role = normalizeRole(actor.role);
  if (role === "csr") {
    const [shift] = await db.select().from(labTechShiftsTable).where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.techId, actor.id), eq(labTechShiftsTable.status, "active"))).limit(1);
    const scope = shift && isShiftOrderRoutable(shift)
      ? sql`(${ordersTable.assignedShiftId} = ${shift.id} OR (${ordersTable.assignedShiftId} IS NULL AND (${ordersTable.assignedCsrUserId} IS NULL OR ${ordersTable.assignedCsrUserId} = ${actor.id})))`
      : sql`(${ordersTable.assignedShiftId} IS NULL AND (${ordersTable.assignedCsrUserId} IS NULL OR ${ordersTable.assignedCsrUserId} = ${actor.id}))`;
    const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, QUEUE_ORDER_STATUSES), scope)).orderBy(desc(ordersTable.createdAt));
    res.json({ orders, total: orders.length });
    return;
  }
  const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, QUEUE_ORDER_STATUSES))).orderBy(desc(ordersTable.createdAt));
  res.json({ orders, total: orders.length });
});

router.get("/shift-queue/general", requirePermission("queue.view"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const orders = await db.select({
    id: ordersTable.id, status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus,
    assignedCsrUserId: ordersTable.assignedCsrUserId, acceptedAt: ordersTable.acceptedAt,
    routeSource: ordersTable.routeSource, total: ordersTable.total, createdAt: ordersTable.createdAt,
  }).from(ordersTable).where(and(
    eq(ordersTable.tenantId, tenantId), isNull(ordersTable.assignedShiftId),
    inArray(ordersTable.status, QUEUE_ORDER_STATUSES),
  )).orderBy(desc(ordersTable.createdAt));
  res.json({ orders, total: orders.length });
});

router.get("/shift-queue/general/session", requirePermission("cash_sessions.view"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const session = await currentGeneralQueueSession(tenantId);
  if (!session) { res.json({ session: null, participants: [] }); return; }
  const participants = await db.select({
    id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName,
    email: usersTable.email, joinedAt: generalQueueCashSessionParticipantsTable.joinedAt,
  }).from(generalQueueCashSessionParticipantsTable)
    .innerJoin(usersTable, eq(usersTable.id, generalQueueCashSessionParticipantsTable.userId))
    .where(and(
      eq(generalQueueCashSessionParticipantsTable.tenantId, tenantId),
      eq(generalQueueCashSessionParticipantsTable.sessionId, session.id),
      isNull(generalQueueCashSessionParticipantsTable.leftAt),
    ));
  res.json({ session, participants });
});

router.get("/shift-queue/general/session/options", requirePermission("cash_sessions.manage"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const rows = await db.select({
    registerBoxId: csrBoxesTable.id, registerLabel: csrBoxesTable.label,
    locationId: inventoryLocationsTable.id, locationName: inventoryLocationsTable.name,
  }).from(csrBoxesTable).innerJoin(inventoryLocationsTable, and(
    eq(inventoryLocationsTable.csrBoxId, csrBoxesTable.id),
    eq(inventoryLocationsTable.tenantId, tenantId),
    eq(inventoryLocationsTable.isActive, true),
  )).where(and(eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.isActive, true)));
  res.json({ options: rows });
});

router.post("/shift-queue/general/session/open", requirePermission("cash_sessions.manage"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const role = normalizeRole(actor.role);
  if (!supervisorRoles.has(role)) { res.status(403).json({ error: "Supervisor permission is required" }); return; }
  const parsed = z.object({
    registerBoxId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    openingBalance: z.number().finite().min(0).max(100000).default(0),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(422).json({ error: "Select an authorized register and location" }); return; }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  try {
    const session = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${tenantId}, ${parsed.data.registerBoxId})`);
      const [register] = await tx.select().from(csrBoxesTable).where(and(eq(csrBoxesTable.id, parsed.data.registerBoxId), eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.isActive, true))).limit(1);
      const [location] = await tx.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.id, parsed.data.locationId), eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.csrBoxId, parsed.data.registerBoxId), eq(inventoryLocationsTable.isActive, true))).limit(1);
      if (!register || !location) return null;
      const [existing] = await tx.select().from(generalQueueCashSessionsTable).where(and(eq(generalQueueCashSessionsTable.tenantId, tenantId), eq(generalQueueCashSessionsTable.locationId, location.id), eq(generalQueueCashSessionsTable.registerBoxId, register.id), eq(generalQueueCashSessionsTable.status, "open"))).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(generalQueueCashSessionsTable).values({ tenantId, locationId: location.id, registerBoxId: register.id, openedByUserId: actor.id, openingBalance: parsed.data.openingBalance.toFixed(2) }).returning();
      await tx.insert(generalQueueCashSessionParticipantsTable).values({ tenantId, sessionId: created.id, userId: actor.id, joinedByUserId: actor.id });
      await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "GENERAL_QUEUE_SESSION_OPENED", resourceType: "general_queue_session", resourceId: String(created.id), metadata: { locationId: location.id, registerBoxId: register.id, openingBalance: parsed.data.openingBalance } });
      return created;
    });
    if (!session) { res.status(422).json({ error: "The register/location is not authorized for this tenant" }); return; }
    res.status(201).json({ session });
  } catch {
    res.status(409).json({ error: "An active General Queue cash session already exists for that register" });
  }
});

router.post("/shift-queue/general/session/:id/join", requirePermission("cash_sessions.join"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId)) { res.status(400).json({ error: "Invalid session id" }); return; }
  const [session] = await db.select().from(generalQueueCashSessionsTable).where(and(eq(generalQueueCashSessionsTable.id, sessionId), eq(generalQueueCashSessionsTable.tenantId, tenantId), eq(generalQueueCashSessionsTable.status, "open"))).limit(1);
  if (!session) { res.status(404).json({ error: "Open General Queue session not found" }); return; }
  await db.insert(generalQueueCashSessionParticipantsTable).values({ tenantId, sessionId, userId: actor.id, joinedByUserId: actor.id })
    .onConflictDoUpdate({ target: [generalQueueCashSessionParticipantsTable.sessionId, generalQueueCashSessionParticipantsTable.userId], set: { leftAt: null, joinedAt: new Date(), joinedByUserId: actor.id } });
  await db.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "GENERAL_QUEUE_SESSION_JOINED", resourceType: "general_queue_session", resourceId: String(sessionId), metadata: {} });
  res.json({ joined: true });
});

router.post("/shift-queue/general/session/:id/close", requirePermission("cash_sessions.manage"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const role = normalizeRole(actor.role);
  if (!supervisorRoles.has(role)) { res.status(403).json({ error: "Supervisor permission is required" }); return; }
  const parsed = z.object({ closingBalance: z.number().finite().min(0).max(100000) }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(422).json({ error: "A valid closing balance is required" }); return; }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const sessionId = Number(req.params.id);
  const [closed] = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(generalQueueCashSessionsTable).where(and(eq(generalQueueCashSessionsTable.id, sessionId), eq(generalQueueCashSessionsTable.tenantId, tenantId), eq(generalQueueCashSessionsTable.status, "open"))).for("update").limit(1);
    if (!session) return [null];
    const [totals] = await tx.select({ cash: sql<string>`coalesce(sum(${cashLedgerEntriesTable.amount}), 0)` }).from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.generalQueueSessionId, sessionId)));
    const expected = Number(session.openingBalance) + Number(totals?.cash ?? 0);
    const difference = parsed.data.closingBalance - expected;
    const rows = await tx.update(generalQueueCashSessionsTable).set({ status: "closed", closedByUserId: actor.id, closedAt: new Date(), closingBalance: parsed.data.closingBalance.toFixed(2), expectedBalance: expected.toFixed(2), differenceAmount: difference.toFixed(2), paymentTotalsJson: { cash: Number(totals?.cash ?? 0) } }).where(and(eq(generalQueueCashSessionsTable.id, sessionId), eq(generalQueueCashSessionsTable.status, "open"))).returning();
    await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "GENERAL_QUEUE_SESSION_CLOSED", resourceType: "general_queue_session", resourceId: String(sessionId), metadata: { expectedBalance: expected, closingBalance: parsed.data.closingBalance, difference } });
    return rows;
  });
  if (!closed) { res.status(409).json({ error: "General Queue session is already closed or unavailable" }); return; }
  res.json({ session: closed });
});

export default router;
