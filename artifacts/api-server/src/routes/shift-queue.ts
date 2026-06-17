import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, labTechShiftsTable, ordersTable, shiftRoutingConfigTable, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole, normalizeRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
const ACTIVE_ORDER_STATUSES = ["pending", "queued", "assigned", "in_progress"];

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
  const activeOrders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, ACTIVE_ORDER_STATUSES)));
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
    if (!shift) {
      res.status(403).json({ error: "CSR must have an active shift to view the operational queue", orders: [] });
      return;
    }
    const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.assignedShiftId, shift.id), inArray(ordersTable.status, ACTIVE_ORDER_STATUSES))).orderBy(desc(ordersTable.createdAt));
    res.json({ orders, total: orders.length });
    return;
  }
  const orders = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), inArray(ordersTable.status, ACTIVE_ORDER_STATUSES))).orderBy(desc(ordersTable.createdAt));
  res.json({ orders, total: orders.length });
});

export default router;
