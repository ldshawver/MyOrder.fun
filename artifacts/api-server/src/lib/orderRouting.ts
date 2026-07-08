import { eq, sql } from "drizzle-orm";
import {
  db,
  ordersTable,
  usersTable,
  labTechShiftsTable,
  adminSettingsTable,
  shiftRoutingConfigTable,
} from "@workspace/db";
import { normalizeRole } from "./auth";

/**
 *
 * Routing rule names (admin_settings.orderRoutingRule):
 *   round_robin                  — default. Pick the active CSR with the
 *                                  oldest max(routedAt). Tie-break by id.
 *   least_recent_order           — Pick the active CSR whose most recent
 *                                  acceptedAt is oldest (or has none yet).
 *   supervisor_manual_assignment — Never auto-route. Order sits in the
 *                                  General Account fallback queue until
 *                                  a supervisor reassigns it.
 *
 * `route_source` (the provenance recorded on the order) follows the spec
 * vocabulary and is one of:
 *   active_csr          a CSR was on shift and got the assignment
 *   general_account     no active CSR; assignedCsrUserId stays null
 *   supervisor_override stamped by reassignOrder()
 */

export type RouteSource = "active_csr" | "general_account" | "supervisor_override";

export const GENERAL_ACCOUNT_EMAIL = "info@adiken.com";

export type RoutingRule =
  | "round_robin"
  | "least_recent_order"
  | "supervisor_manual_assignment";

export type RoutingDecision = {
  assignedCsrUserId: number | null;
  /** Active shift id for the assigned CSR, when one exists. */
  assignedShiftId: number | null;
  routeSource: RouteSource;
  rule: RoutingRule;
  routedTo: "csr_shift" | "default_queue";
  routedToEmail: string | null;
  routingStatus: "green" | "yellow";
  routingMessage: string;
  estimatedReadyAt: Date;
  promisedMinutes: number;
};

const ROUTING_ROLES = ["csr"] as const;

let shiftRoutingConfigSchemaEnsured = false;

export async function ensureShiftRoutingConfigSchema(): Promise<void> {
  if (shiftRoutingConfigSchemaEnsured) return;
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
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "shift_routing_config_tenant_idx" ON "shift_routing_config" ("tenant_id")`);
  shiftRoutingConfigSchemaEnsured = true;
}

async function getRoutingSettings(): Promise<{ rule: RoutingRule; defaultEtaMinutes: number }> {
  const [s] = await db.select().from(adminSettingsTable).limit(1);
  const rule = (s?.orderRoutingRule as RoutingRule | undefined) ?? "round_robin";
  const defaultEtaMinutes = s?.defaultEtaMinutes ?? 30;
  return { rule, defaultEtaMinutes };
}

export async function getApprovedMultiShiftConfig(tenantId: number) {
  await ensureShiftRoutingConfigSchema();
  const [config] = await db.select().from(shiftRoutingConfigTable)
    .where(eq(shiftRoutingConfigTable.tenantId, tenantId))
    .orderBy(sql`${shiftRoutingConfigTable.approvedAt} DESC NULLS LAST`, sql`${shiftRoutingConfigTable.createdAt} DESC`)
    .limit(1);
  return config?.allowMultipleActiveShifts ? config : null;
}

type ActiveCsr = { userId: number; shiftId: number };

export type ShiftReadinessCheck = { ready: boolean; failedConditions: string[] };

const CSR_BOX_LOCATION_NAMES: Record<string, string> = {
  "sales-box-1": "CSR Sales Box 1",
  "sales-box-2": "CSR Sales Box 2",
};

export function inventoryLocationNameForBoxAssignment(boxAssignmentId: string | null | undefined): string | null {
  if (!boxAssignmentId) return null;
  return CSR_BOX_LOCATION_NAMES[boxAssignmentId.trim()] ?? null;
}


type ShiftSetupState = {
  boxAssignmentId?: unknown;
  inventoryConfirmed?: unknown;
  startingInventoryConfirmed?: unknown;
  parLevelsConfirmed?: unknown;
  printerReady?: unknown;
  printerAssigned?: unknown;
};

export function getShiftReadiness(shift: {
  tenantId?: number | null;
  expectedTenantId?: number | null;
  status?: string | null;
  clockedOutAt?: Date | string | null;
  boxAssignmentId?: string | null;
  setupJson?: unknown;
}): ShiftReadinessCheck {
  const setup = (shift.setupJson && typeof shift.setupJson === "object" ? shift.setupJson : {}) as ShiftSetupState;
  const boxAssignmentId = typeof shift.boxAssignmentId === "string" && shift.boxAssignmentId.trim()
    ? shift.boxAssignmentId.trim()
    : typeof setup.boxAssignmentId === "string" ? setup.boxAssignmentId.trim() : "";
  const failedConditions: string[] = [];
  if (shift.expectedTenantId != null && shift.tenantId != null && shift.tenantId !== shift.expectedTenantId) failedConditions.push("tenant_mismatch");
  if (shift.status !== "active") failedConditions.push("shift_status_not_active");
  if (shift.clockedOutAt != null) failedConditions.push("shift_clocked_out");
  if (!boxAssignmentId) failedConditions.push("box_not_assigned");
  if (!inventoryLocationNameForBoxAssignment(boxAssignmentId)) failedConditions.push("inventory_location_not_assigned");
  return { ready: failedConditions.length === 0, failedConditions };
}

export function isShiftOrderRoutable(shift: {
  tenantId?: number | null;
  expectedTenantId?: number | null;
  status?: string | null;
  clockedOutAt?: Date | string | null;
  boxAssignmentId?: string | null;
  setupJson?: unknown;
}): boolean {
  return getShiftReadiness(shift).ready;
}

export async function listActiveCsrs(tenantId?: number): Promise<ActiveCsr[]> {
  const rows = await db
    .select({
      userId: labTechShiftsTable.techId,
      shiftId: labTechShiftsTable.id,
      tenantId: labTechShiftsTable.tenantId,
      boxAssignmentId: labTechShiftsTable.boxAssignmentId,
      setupJson: labTechShiftsTable.setupJson,
      status: labTechShiftsTable.status,
      clockedOutAt: labTechShiftsTable.clockedOutAt,
      role: usersTable.role,
    })
    .from(labTechShiftsTable)
    .innerJoin(usersTable, eq(labTechShiftsTable.techId, usersTable.id))
    .where(tenantId
      ? sql`${labTechShiftsTable.status} = 'active' AND ${labTechShiftsTable.clockedOutAt} IS NULL AND ${labTechShiftsTable.tenantId} = ${tenantId}`
      : sql`${labTechShiftsTable.status} = 'active' AND ${labTechShiftsTable.clockedOutAt} IS NULL`);
  const seen = new Map<number, ActiveCsr>();
  for (const r of rows) {
    if (!(ROUTING_ROLES as readonly string[]).includes(normalizeRole(r.role))) continue;
    if (!isShiftOrderRoutable({ ...r, expectedTenantId: tenantId })) continue;
    if (!seen.has(r.userId)) seen.set(r.userId, { userId: r.userId, shiftId: r.shiftId });
  }
  return [...seen.values()].sort((a, b) => a.userId - b.userId);
}

export async function isActiveCsr(userId: number): Promise<boolean> {
  const all = await listActiveCsrs();
  return all.some(c => c.userId === userId);
}

export async function decideRouting(tenantId?: number): Promise<RoutingDecision> {
  const { rule, defaultEtaMinutes } = await getRoutingSettings();
  const eta = new Date(Date.now() + defaultEtaMinutes * 60_000);
  // Routing behavior:
  // 1. Find active CSR shifts.
  // 2. Keep only shifts that are eligible for orders: status active, still
  //    clocked in, and assigned to a CSR sales box.
  // 3. If no ready CSR remains, route to the General Account fallback
  //    (info@adiken.com) by leaving assignedCsrUserId/shiftId null.
  // 4. If one ready CSR remains, route directly to that CSR.
  // 5. If multiple ready CSRs remain, use the configured strategy:
  //    supervisor_manual_assignment => General Account/manual queue;
  //    least_recent_order => least recently accepted order;
  //    round_robin/default => least recently routed order.
  // general_account always carries assignedShiftId=null — the order is unowned,
  // so there is no shift to attach to. Active-CSR assignments alone populate
  // assignedShiftId.
  const baseGeneral: Omit<RoutingDecision, "rule"> = {
    assignedCsrUserId: null,
    assignedShiftId: null,
    routeSource: "general_account",
    routedTo: "default_queue",
    routedToEmail: GENERAL_ACCOUNT_EMAIL,
    routingStatus: "yellow",
    routingMessage: `No ready CSR shift. Orders are routing to General Account (${GENERAL_ACCOUNT_EMAIL}).`,
    estimatedReadyAt: eta,
    promisedMinutes: defaultEtaMinutes,
  };

  const active = await listActiveCsrs(tenantId);
  if (active.length === 0) return { ...baseGeneral, rule };

  // Spec: exactly one active CSR → always assign to that CSR regardless of
  // the configured rule. The rule (round_robin / least_recent_order /
  // supervisor_manual_assignment) only kicks in when there are multiple
  // active CSRs to choose between.
  if (active.length === 1) {
    const only = active[0]!;
    return {
      assignedCsrUserId: only.userId,
      assignedShiftId: only.shiftId,
      routeSource: "active_csr",
      routedTo: "csr_shift",
      routedToEmail: null,
      routingStatus: "green",
      routingMessage: "Orders are routing to the active CSR shift.",
      rule,
      estimatedReadyAt: eta,
      promisedMinutes: defaultEtaMinutes,
    };
  }

  if (rule === "supervisor_manual_assignment") {
    return { ...baseGeneral, rule };
  }

  const approved = tenantId ? await getApprovedMultiShiftConfig(tenantId) : ({ routingStrategy: rule } as { routingStrategy: string });
  // POS acceptance rule: active CSR shifts should receive orders even when an
  // explicit multi-shift approval row has not been created yet. Falling back to
  // round_robin prevents orders from landing in the General Queue while active,
  // clocked-in, boxed CSRs are available.
  const activeConfig = approved ?? ({ routingStrategy: rule === "least_recent_order" ? "least_recent_order" : "round_robin" } as { routingStrategy: string });
  const approvedRule = activeConfig.routingStrategy === "default_queue" || activeConfig.routingStrategy === "manual" ? "supervisor_manual_assignment" : "round_robin";
  if (approvedRule === "supervisor_manual_assignment") {
    return { ...baseGeneral, rule: approvedRule, routingMessage: "Multiple active CSR shifts approved; orders are routing to default queue/manual assignment." };
  }

  let pick: ActiveCsr;

  if (activeConfig.routingStrategy === "round_robin" || activeConfig.routingStrategy === "geo" || activeConfig.routingStrategy === "pickup_delivery") {
    // Current data model does not yet have geo/pickup buckets; use a fair
    // round-robin fallback while preserving the approved strategy on orders.
  }
  if (rule === "least_recent_order") {
    const stats = await db
      .select({
        userId: ordersTable.assignedCsrUserId,
        last: sql<Date | null>`MAX(${ordersTable.acceptedAt})`,
      })
      .from(ordersTable)
      .where(sql`${ordersTable.assignedCsrUserId} IS NOT NULL`)
      .groupBy(ordersTable.assignedCsrUserId);
    const lastByUser = new Map<number, number>();
    for (const r of stats) {
      if (r.userId != null && r.last) lastByUser.set(r.userId, new Date(r.last).getTime());
    }
    pick = [...active].sort((a, b) =>
      (lastByUser.get(a.userId) ?? 0) - (lastByUser.get(b.userId) ?? 0),
    )[0]!;
  } else {
    // round_robin (default): least-recently routed-to
    const stats = await db
      .select({
        userId: ordersTable.assignedCsrUserId,
        last: sql<Date | null>`MAX(${ordersTable.routedAt})`,
      })
      .from(ordersTable)
      .where(sql`${ordersTable.assignedCsrUserId} IS NOT NULL`)
      .groupBy(ordersTable.assignedCsrUserId);
    const lastByUser = new Map<number, number>();
    for (const r of stats) {
      if (r.userId != null && r.last) lastByUser.set(r.userId, new Date(r.last).getTime());
    }
    pick = [...active].sort((a, b) =>
      (lastByUser.get(a.userId) ?? 0) - (lastByUser.get(b.userId) ?? 0),
    )[0]!;
  }

  return {
    assignedCsrUserId: pick.userId,
    assignedShiftId: pick.shiftId,
    routeSource: "active_csr",
    routedTo: "csr_shift",
    routedToEmail: null,
    routingStatus: "green",
    routingMessage: "Orders are routing across approved active CSR shifts.",
    rule: activeConfig.routingStrategy as RoutingRule,
    estimatedReadyAt: eta,
    promisedMinutes: defaultEtaMinutes,
  };
}

/**
 * Supervisor reassignment. Target user (when not null) must already be an
 * active CSR. The route_source is stamped `supervisor_override`.
 */
export async function reassignOrder(orderId: number, newUserId: number | null) {
  let shiftId: number | null = null;
  if (newUserId !== null) {
    const active = await listActiveCsrs();
    const found = active.find(c => c.userId === newUserId);
    if (!found) {
      throw new Error("Reassignment target must be a currently active CSR");
    }
    shiftId = found.shiftId;
  }
  const now = new Date();
  // Inspect existing terminal state once so both fulfillmentStatus and
  // legacy status can be preserved consistently. Resetting to
  // submitted/pending only happens for in-flight orders so the
  // recipient CSR's "Accept Order" alert action works (the accept
  // endpoint requires submitted state).
  const [existing] = await db
    .select({ f: ordersTable.fulfillmentStatus, s: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .limit(1);
  const TERMINAL_FULFILLMENT = new Set(["ready", "completed", "cancelled"]);
  const TERMINAL_STATUS = new Set(["completed", "cancelled", "ready", "delivered", "refunded"]);
  const isTerminal =
    TERMINAL_FULFILLMENT.has(existing?.f ?? "") || TERMINAL_STATUS.has(existing?.s ?? "");
  const update: Partial<typeof ordersTable.$inferInsert> = {
    assignedCsrUserId: newUserId,
    assignedShiftId: shiftId,
    routeSource: "supervisor_override",
    routedAt: now,
    acceptedAt: null,
  };
  if (!isTerminal) {
    update.fulfillmentStatus = "submitted";
    update.status = "pending";
  }
  const [updated] = await db
    .update(ordersTable)
    .set(update)
    .where(eq(ordersTable.id, orderId))
    .returning();
  return updated;
}
