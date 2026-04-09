/**
 * printRouter.ts — Active operator selection + printer health probes.
 *
 * Operator priority:
 *   1. Most-recent active shift from lab_tech_shifts (any role — lab_tech, business_sitter, etc.)
 *   2. Fallback: first active global_admin / tenant_admin / business_sitter
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
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import type { PrintPrinter, OperatorPrintProfile } from "@workspace/db";

export type ActiveOperator = {
  userId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  source: "shift" | "admin_fallback";
  profile: OperatorPrintProfile | null;
};

/**
 * Find the active operator:
 * 1. Most-recent active shift (any role — lab_tech, business_sitter, etc.)
 * 2. Fallback: first global_admin / tenant_admin / business_sitter
 */
export async function selectActiveOperator(): Promise<ActiveOperator | null> {
  // 1. Active lab tech shift
  const shifts = await db
    .select({
      techId: labTechShiftsTable.techId,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
    })
    .from(labTechShiftsTable)
    .innerJoin(usersTable, eq(labTechShiftsTable.techId, usersTable.id))
    .where(eq(labTechShiftsTable.status, "active"))
    .orderBy(desc(labTechShiftsTable.clockedInAt))
    .limit(1);

  if (shifts.length > 0) {
    const tech = shifts[0];
    const profile = await getOperatorProfile(tech.techId);
    return {
      userId: tech.techId,
      email: tech.email,
      firstName: tech.firstName ?? null,
      lastName: tech.lastName ?? null,
      role: tech.role,
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
      )
    )
    .limit(10);

  // Priority: global_admin > tenant_admin > business_sitter
  const admin = admins.find(u => u.role === "global_admin")
    ?? admins.find(u => u.role === "tenant_admin")
    ?? admins.find(u => u.role === "business_sitter");

  if (!admin) return null;

  const profile = await getOperatorProfile(admin.id);
  return {
    userId: admin.id,
    email: admin.email,
    firstName: admin.firstName ?? null,
    lastName: admin.lastName ?? null,
    role: admin.role,
    source: "admin_fallback",
    profile,
  };
}

/** Load operator's print profile (or null if not configured). */
export async function getOperatorProfile(userId: number): Promise<OperatorPrintProfile | null> {
  const rows = await db
    .select()
    .from(operatorPrintProfilesTable)
    .where(eq(operatorPrintProfilesTable.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve receipt printer chain for an operator: [primary, fallback]. */
export async function resolveReceiptPrinters(
  profile: OperatorPrintProfile | null
): Promise<{ primary: PrintPrinter | null; fallback: PrintPrinter | null }> {
  const fetch = async (id: number | null | undefined): Promise<PrintPrinter | null> => {
    if (!id) return null;
    const rows = await db.select().from(printPrintersTable).where(eq(printPrintersTable.id, id)).limit(1);
    return rows[0] ?? null;
  };

  if (!profile) {
    // No profile — find any active receipt-role printer (ethernet_direct preferred, then bridge)
    const allActive = await db.select().from(printPrintersTable)
      .where(and(eq(printPrintersTable.isActive, true), eq(printPrintersTable.role, "receipt")));
    const primary = allActive.find(p => p.connectionType === "ethernet_direct")
      ?? allActive.find(p => ["bridge", "mac_bridge"].includes(p.connectionType))
      ?? allActive[0]
      ?? null;
    const fallback = allActive.find(p => p.connectionType === "pi_bridge") ?? null;
    return { primary, fallback };
  }

  return {
    primary: await fetch(profile.receiptPrinterId),
    fallback: await fetch(profile.fallbackReceiptPrinterId),
  };
}

/** Resolve label printer for an operator. */
export async function resolveLabelPrinter(
  profile: OperatorPrintProfile | null
): Promise<PrintPrinter | null> {
  if (!profile?.labelPrinterId) {
    // find any active label-role printer (bridge, mac_bridge, or ethernet_direct)
    const rows = await db.select().from(printPrintersTable)
      .where(and(eq(printPrintersTable.isActive, true), eq(printPrintersTable.role, "label")))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, profile.labelPrinterId)).limit(1);
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

/** Probe an HTTP bridge's /health endpoint. Resolves true if status === "ok". */
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
    const data = await res.json() as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/** Check reachability of any printer based on its connection type. */
export async function probePrinter(printer: PrintPrinter): Promise<boolean> {
  const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";

  if (printer.connectionType === "ethernet_direct") {
    if (!printer.directIp) return false;
    return probeEthernet(printer.directIp, printer.directPort ?? 9100, printer.timeoutMs ?? 3000);
  }

  if (["mac_bridge", "pi_bridge", "bridge"].includes(printer.connectionType)) {
    if (!printer.bridgeUrl) return false;
    return probeBridge(printer.bridgeUrl, apiKey, printer.timeoutMs ?? 4000);
  }

  return false;
}
