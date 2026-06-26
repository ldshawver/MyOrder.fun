import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, labTechShiftsTable, ordersTable, shiftRoutingConfigTable, usersTable } from "@workspace/db";
import { isShiftOrderRoutable } from "../lib/orderRouting";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole, normalizeRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
const QUEUE_ORDER_STATUSES = ["pending", "processing", "ready", "completed"];

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

router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("csr", "supervisor", "admin", "global_admin"));

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

router.get("/shift-queue/status", async (req, res): Promise<void> => {
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
  let health: "green" | "yellow" = "green";
  let message = activeShift ? `Orders are routing to active CSR: ${`${activeShift.firstName ?? ""} ${activeShift.lastName ?? ""}`.trim() || activeShift.email}. Shift active for ${Math.floor(activeDurationSeconds / 3600)}h ${Math.floor((activeDurationSeconds % 3600) / 60)}m.` : "No active CSR shift. Orders are routing to default queue.";
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
    multipleActiveShifts: multiple,
    multipleActiveShiftsApproved: approved,
    routingStrategy: config?.routingStrategy ?? (activeShift ? "active_csr" : "default_queue"),
    queueCounts: { queued: activeOrders.length, defaultQueue: defaultQueueCount, assigned: activeOrders.length - defaultQueueCount },
  });
});

router.get("/shift-queue/orders", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const role = normalizeRole(actor.role);
  if (role === "csr") {
    const [shift] = await db.select().from(labTechShiftsTable).where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.techId, actor.id), eq(labTechShiftsTable.status, "active"))).limit(1);
    if (!shift || !isShiftOrderRoutable(shift)) {
      res.status(403).json({ error: "CSR must have an active ready shift to view the operational queue", orders: [] });
      return;
    }
    const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, QUEUE_ORDER_STATUSES), sql`(${ordersTable.assignedShiftId} = ${shift.id} OR (${ordersTable.assignedShiftId} IS NULL AND ${ordersTable.assignedCsrUserId} IS NULL))`)).orderBy(desc(ordersTable.createdAt));
    res.json({ orders, total: orders.length });
    return;
  }
  const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, QUEUE_ORDER_STATUSES))).orderBy(desc(ordersTable.createdAt));
  res.json({ orders, total: orders.length });
});

export default router;
