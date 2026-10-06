/**
 * printRouter.ts — Active operator selection + printer health probes.
 *
 * Operator priority:
 *   1. Most-recent active shift from lab_tech_shifts (any role — lab_tech, business_sitter, etc.)
 *   2. Fallback: first active global_admin / admin / business_sitter
 *
 * Health probes (VPS-side socket/HTTP checks):
 *   - ethernet_direct: TCP connect to directIp:directPort
 *   - mac_bridge / pi_bridge / bridge: GET /health on bridgeUrl
 */

import net from "net";
import { db } from "@workspace/db";
import {
  labTechShiftsTable,
  usersTable,
  operatorPrintProfilesTable,
  printPrintersTable,
  shiftPrintAssignmentsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type { PrintPrinter, OperatorPrintProfile } from "@workspace/db";
import { normalizeRole } from "./auth";

export type ActiveOperator = {
  userId: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  tenantId: number;
  shiftId: number | null;
  locationId: number | null;
  source: "shift" | "admin_fallback";
  profile: OperatorPrintProfile | null;
};

/** Prefer a profile-specific credential, otherwise use the centrally managed one. */
export function resolveBridgeApiKey(profileApiKey: string | null | undefined): string {
  return profileApiKey || process.env.PRINT_BRIDGE_API_KEY || "";
}

/**
 * Find the active operator:
 * 1. Most-recent active shift (any role — lab_tech, business_sitter, etc.)
 * 2. Fallback: first global_admin / admin / business_sitter
 */
export async function selectActiveOperator(tenantId: number): Promise<ActiveOperator | null> {
  // 1. Active lab tech shift
  const shifts = await db
    .select({
      techId: labTechShiftsTable.techId,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      shiftId: labTechShiftsTable.id,
    })
    .from(labTechShiftsTable)
    .innerJoin(usersTable, eq(labTechShiftsTable.techId, usersTable.id))
    .where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active")))
    .orderBy(desc(labTechShiftsTable.clockedInAt))
    .limit(1);

  if (shifts.length > 0) {
    const tech = shifts[0];
    const [assignment] = await db.select().from(shiftPrintAssignmentsTable)
      .where(and(eq(shiftPrintAssignmentsTable.tenantId, tenantId), eq(shiftPrintAssignmentsTable.shiftId, tech.shiftId))).limit(1);
    const profile = await getOperatorProfile(tenantId, tech.techId, null, null);
    return {
      userId: tech.techId,
      email: tech.email ?? "",
      firstName: tech.firstName ?? null,
      lastName: tech.lastName ?? null,
      role: tech.role,
      tenantId,
      shiftId: tech.shiftId,
      locationId: assignment?.locationId ?? null,
      source: "shift",
      profile,
    };
  }

  // 2. Admin fallback
  const admins = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.isActive, true),
        eq(usersTable.tenantId, tenantId),
      )
    )
    .limit(10);

  const admin = admins.find(u => normalizeRole(u.role) === "global_admin")
    ?? admins.find(u => normalizeRole(u.role) === "admin")
    ?? admins.find(u => normalizeRole(u.role) === "csr");

  if (!admin) return null;

  const profile = await getOperatorProfile(tenantId, admin.id, null, null);
  return {
    userId: admin.id,
    email: admin.email ?? "",
    firstName: admin.firstName ?? null,
    lastName: admin.lastName ?? null,
    role: admin.role,
    tenantId,
    shiftId: null,
    locationId: null,
    source: "admin_fallback",
    profile,
  };
}

/** Load operator's print profile (or null if not configured). */
export async function getOperatorProfile(tenantId: number, userId: number, locationId: number | null = null, shiftId: number | null = null): Promise<OperatorPrintProfile | null> {
  const rows = await db
    .select()
    .from(operatorPrintProfilesTable)
    .where(and(
      eq(operatorPrintProfilesTable.tenantId, tenantId),
      eq(operatorPrintProfilesTable.userId, userId),
      locationId === null ? sql`${operatorPrintProfilesTable.locationId} IS NULL` : eq(operatorPrintProfilesTable.locationId, locationId),
      shiftId === null ? sql`${operatorPrintProfilesTable.shiftId} IS NULL` : eq(operatorPrintProfilesTable.shiftId, shiftId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve receipt printer chain for an operator: [primary, fallback]. */
export async function resolveReceiptPrinters(
  profile: OperatorPrintProfile | null,
  context: { tenantId: number; locationId?: number | null; shiftId?: number | null },
): Promise<{ primary: PrintPrinter | null; fallback: PrintPrinter | null }> {
  const fetch = async (id: number | null | undefined): Promise<PrintPrinter | null> => {
    if (!id) return null;
    const rows = await db.select().from(printPrintersTable).where(and(
      eq(printPrintersTable.id, id), eq(printPrintersTable.tenantId, context.tenantId), eq(printPrintersTable.isActive, true),
      context.locationId == null
        ? and(eq(printPrintersTable.routingScope, "general"), sql`${printPrintersTable.locationId} IS NULL`)
        : and(eq(printPrintersTable.routingScope, "location"), eq(printPrintersTable.locationId, context.locationId)),
    )).limit(1);
    return rows[0] ?? null;
  };

  if (context.shiftId && context.locationId) {
    const [assignment] = await db.select().from(shiftPrintAssignmentsTable).where(and(
      eq(shiftPrintAssignmentsTable.tenantId, context.tenantId),
      eq(shiftPrintAssignmentsTable.shiftId, context.shiftId),
      eq(shiftPrintAssignmentsTable.locationId, context.locationId),
    )).limit(1);
    return { primary: await fetch(assignment?.receiptPrinterId), fallback: null };
  }

  // A tenant/location printer is the safe operational fallback when an
  // operator has not yet been given a personal print profile. Keep the
  // lookup tenant-scoped and require an active general receipt printer.
  if (!profile) {
    const rows = await db.select().from(printPrintersTable).where(and(
      eq(printPrintersTable.tenantId, context.tenantId),
      eq(printPrintersTable.isActive, true),
      sql`${printPrintersTable.role} IN ('customer_receipt', 'receipt')`,
      eq(printPrintersTable.routingScope, "general"),
      sql`${printPrintersTable.locationId} IS NULL`,
    )).limit(1);
    return { primary: rows[0] ?? null, fallback: null };
  }

  return {
    primary: await fetch(profile.receiptPrinterId),
    fallback: null,
  };
}

export async function resolveExpoPrinter(context: { tenantId: number; locationId: number; shiftId: number }): Promise<PrintPrinter | null> {
  const [assignment] = await db.select().from(shiftPrintAssignmentsTable).where(and(
    eq(shiftPrintAssignmentsTable.tenantId, context.tenantId), eq(shiftPrintAssignmentsTable.shiftId, context.shiftId),
    eq(shiftPrintAssignmentsTable.locationId, context.locationId), eq(shiftPrintAssignmentsTable.printExpoTickets, true),
  )).limit(1);
  if (!assignment?.expoPrinterId) {
    // A tenant-scoped receipt printer is a safe fallback for sites that have
    // not yet provisioned a dedicated expo device.  Keep this location aware
    // when possible, and never cross the tenant boundary.
    const [fallback] = await db.select().from(printPrintersTable).where(and(
      eq(printPrintersTable.tenantId, context.tenantId),
      eq(printPrintersTable.isActive, true),
      sql`${printPrintersTable.role} IN ('customer_receipt', 'receipt')`,
      eq(printPrintersTable.routingScope, "general"),
      sql`${printPrintersTable.locationId} IS NULL`,
    )).limit(1);
    return fallback ?? null;
  }
  const [printer] = await db.select().from(printPrintersTable).where(and(
    eq(printPrintersTable.tenantId, context.tenantId), eq(printPrintersTable.locationId, context.locationId),
    eq(printPrintersTable.routingScope, "location"), eq(printPrintersTable.role, "expo"),
    eq(printPrintersTable.id, assignment.expoPrinterId), eq(printPrintersTable.isActive, true),
  )).limit(1);
  return printer ?? null;
}

/** Resolve label printer for an operator. */
export async function resolveLabelPrinter(
  profile: OperatorPrintProfile | null,
  tenantId: number,
): Promise<PrintPrinter | null> {
  if (!profile?.labelPrinterId) {
    return null;
  }
  const rows = await db.select().from(printPrintersTable)
    .where(and(eq(printPrintersTable.id, profile.labelPrinterId), eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.isActive, true), eq(printPrintersTable.routingScope, "general"), sql`${printPrintersTable.locationId} IS NULL`)).limit(1);
  return rows[0] ?? null;
}

// ── Health Probes ─────────────────────────────────────────────────────────────

/** Probe a raw TCP socket (ethernet_direct). Resolves true if connectable. */
export function probeEthernet(
  ip: string,
  port: number,
  timeoutMs = 3000
): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

/**
 * Probe an HTTP bridge's /health endpoint.
 * Accepts both bridge versions:
 *   - New server.js:  { success: true, status: "ok", ... }
 *   - Old Mac bridge: { success: true, message: "...", ... }  (no status field)
 * Returns true if the bridge responded with success or status=ok.
 */
export async function probeBridge(
  bridgeUrl: string,
  apiKey: string,
  timeoutMs = 4000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${bridgeUrl}/health`, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return false;
    const data = await res.json() as { status?: string; success?: boolean };
    return data.status === "ok" || data.success === true;
  } catch {
    return false;
  }
}

/** Check reachability of any printer based on its connection type.
 *  Uses a fixed 3 s cap for health probes — regardless of printer.timeoutMs —
 *  so the admin health page doesn't hang for 8+ s per printer.
 */
export async function probePrinter(printer: PrintPrinter): Promise<boolean> {
  const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
  const PROBE_TIMEOUT_MS = 3000;  // always 3 s for health checks

  if (printer.connectionType === "ethernet_direct") {
    if (!printer.directIp) return false;
    return probeEthernet(printer.directIp, printer.directPort ?? 9100, PROBE_TIMEOUT_MS);
  }

  if (["mac_bridge", "pi_bridge", "bridge"].includes(printer.connectionType)) {
    if (!printer.bridgeUrl) return false;
    return probeBridge(printer.bridgeUrl, apiKey, PROBE_TIMEOUT_MS);
  }

  return false;
}
