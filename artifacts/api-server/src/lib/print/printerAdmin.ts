/**
 * printerAdmin.ts — registering printers and setting document routes.
 *
 * Shared by the admin HTTP routes and the operator maintenance command so both
 * apply the same tenant, location, bridge, paper and routing rules and write
 * the same audit records.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  auditLogsTable,
  inventoryLocationsTable,
  printBridgeProfilesTable,
  printPrintersTable,
  printRoutesTable,
  usersTable,
  type PrintPrinter,
} from "@workspace/db";
import { normalizeRole } from "../roles";
import { FULL_PAGE_SIZE, THERMAL_WIDTHS, type PrintDocumentType, type PrinterClass } from "./documentTypes";
import { validatePrinterForDocument } from "./printRouting";

export class PrintAdminError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface PrintAdminActor {
  id: number;
  email: string | null;
  role: string;
}

// Discovery uses `unassigned`; only an authenticated tenant admin assigns a
// routing function. Legacy roles remain readable during migration.
export const VALID_ROLES = ["unassigned", "customer_receipt", "thank_you", "report", "kitchen", "receipt", "expo", "label", "bar"];
export const BRIDGE_QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/;
const VALID_CONN_TYPES = ["ethernet_direct", "mac_bridge", "pi_bridge", "bridge"];

/**
 * Printer class and paper: thermal rolls are 50mm or 80mm only; full-page
 * printers are always US Letter. Returns the stored pair or an error.
 */
export function printerPaper(printerClass: unknown, paperWidth: unknown): { printerClass: PrinterClass; paperWidth: string } | { error: string } {
  const cls = printerClass === undefined ? "thermal" : printerClass;
  if (cls !== "thermal" && cls !== "full_page") return { error: "printerClass must be thermal or full_page" };
  if (cls === "full_page") {
    if (paperWidth !== undefined && paperWidth !== null && paperWidth !== FULL_PAGE_SIZE) return { error: "Full-page printers use US Letter; omit paperWidth" };
    return { printerClass: "full_page", paperWidth: FULL_PAGE_SIZE };
  }
  const width = paperWidth === undefined || paperWidth === null ? "80mm" : paperWidth;
  if (!(THERMAL_WIDTHS as readonly unknown[]).includes(width)) return { error: "Thermal paperWidth must be 50mm or 80mm" };
  return { printerClass: "thermal", paperWidth: width as string };
}

/** Operator path: the actor must be an active admin of the tenant, or a global admin. */
export async function loadPrintAdminActor(tenantId: number, actorId: number): Promise<PrintAdminActor> {
  const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, actorId)).limit(1);
  const role = normalizeRole(actor?.role);
  if (!actor || !actor.isActive || (role !== "global_admin" && (role !== "admin" || actor.tenantId !== tenantId))) {
    throw new PrintAdminError("Actor must be an active admin of this tenant", 403);
  }
  return { id: actor.id, email: actor.email ?? null, role: actor.role };
}

async function audit(tenantId: number, actor: PrintAdminActor, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  await db.insert(auditLogsTable).values({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email ?? "",
    actorRole: actor.role,
    action,
    resourceType,
    resourceId,
    metadata,
  });
}

async function activeTenantLocation(tenantId: number, locationId: number) {
  const [location] = await db.select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name })
    .from(inventoryLocationsTable)
    .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.isActive, true)))
    .limit(1);
  return location ?? null;
}

/** Registers a printer. Tenant, scope and bridge URL come from the server, never the body. */
export async function createRegisteredPrinter(tenantId: number, actor: PrintAdminActor, body: Record<string, unknown>, via?: string): Promise<PrintPrinter> {
  const b = body;
  if (!b.name) throw new PrintAdminError("name is required");
  if (b.role && !VALID_ROLES.includes(String(b.role))) throw new PrintAdminError(`role must be one of: ${VALID_ROLES.join(", ")}`);
  if (b.connectionType && !VALID_CONN_TYPES.includes(String(b.connectionType))) {
    throw new PrintAdminError(`connectionType must be one of: ${VALID_CONN_TYPES.join(", ")}`);
  }
  const connType = String(b.connectionType ?? "bridge");
  const needsBridge = ["mac_bridge", "pi_bridge", "bridge"].includes(connType);
  if (needsBridge && !b.bridgeProfileId) throw new PrintAdminError("bridgeProfileId is required for bridge printers");
  if (b.bridgePrinterName !== undefined && b.bridgePrinterName !== null && !BRIDGE_QUEUE_NAME.test(String(b.bridgePrinterName).trim())) {
    throw new PrintAdminError("bridgePrinterName is invalid");
  }
  const paper = printerPaper(b.printerClass, b.paperWidth);
  if ("error" in paper) throw new PrintAdminError(paper.error);
  if (connType === "ethernet_direct" && !b.directIp) throw new PrintAdminError("directIp is required for ethernet_direct printers");

  const bridgeProfile = b.bridgeProfileId
    ? (await db.select().from(printBridgeProfilesTable).where(and(
        eq(printBridgeProfilesTable.tenantId, tenantId),
        eq(printBridgeProfilesTable.id, Number(b.bridgeProfileId)),
        eq(printBridgeProfilesTable.isActive, true),
      )).limit(1))[0]
    : null;
  if (needsBridge && !bridgeProfile) throw new PrintAdminError("Active bridge profile not found in this tenant");
  const locationId = b.locationId ? Number(b.locationId) : null;
  const routingScope = locationId ? "location" : "general";
  if (locationId && !(await activeTenantLocation(tenantId, locationId))) {
    throw new PrintAdminError("Active location not found in this tenant");
  }
  const [printer] = await db.insert(printPrintersTable).values({
    tenantId,
    locationId,
    routingScope,
    name: String(b.name),
    role: String(b.role ?? "kitchen"),
    connectionType: connType,
    directIp: b.directIp ? String(b.directIp) : null,
    directPort: b.directPort ? Number(b.directPort) : 9100,
    bridgeProfileId: bridgeProfile?.id ?? null,
    bridgeUrl: bridgeProfile?.bridgeUrl ?? "",
    bridgePrinterName: b.bridgePrinterName ? String(b.bridgePrinterName).trim() : null,
    apiKey: null,
    timeoutMs: b.timeoutMs ? Number(b.timeoutMs) : 8000,
    copies: b.copies ? Math.min(5, Math.max(1, Number(b.copies))) : 1,
    printerClass: paper.printerClass,
    paperWidth: paper.paperWidth,
    isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
  }).returning();
  await audit(tenantId, actor, "PRINT_PRINTER_CREATED", "print_printer", String(printer!.id), {
    locationId,
    routingScope,
    role: printer!.role,
    printerClass: printer!.printerClass,
    bridgeProfileId: printer!.bridgeProfileId,
    ...(via ? { via } : {}),
  });
  return printer!;
}

/** Activates or deactivates a printer; the record is kept for history. */
export async function setPrinterActive(tenantId: number, actor: PrintAdminActor, printerId: number, isActive: boolean, via?: string): Promise<PrintPrinter> {
  const [row] = await db.update(printPrintersTable).set({ isActive })
    .where(and(eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.id, printerId)))
    .returning();
  if (!row) throw new PrintAdminError("Printer not found", 404);
  await audit(tenantId, actor, "PRINT_PRINTER_UPDATED", "print_printer", String(row.id), { fields: ["isActive"], isActive, ...(via ? { via } : {}) });
  return row;
}

/** Sets the one route for (tenant, location or tenant default, document type). */
export async function setDocumentRoute(
  tenantId: number,
  actor: PrintAdminActor,
  input: { documentType: PrintDocumentType; locationId: number | null; printerId: number },
  via?: string,
) {
  const { documentType, locationId, printerId } = input;
  if (locationId !== null && !(await activeTenantLocation(tenantId, locationId))) {
    throw new PrintAdminError("Active location not found in this tenant");
  }
  const [printer] = await db.select().from(printPrintersTable)
    .where(and(eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.id, printerId))).limit(1);
  const problem = await validatePrinterForDocument(printer ?? null, { tenantId, locationId, documentType });
  if (problem) throw new PrintAdminError(`Printer cannot handle this route: ${problem}`);

  const [existing] = await db.select().from(printRoutesTable).where(and(
    eq(printRoutesTable.tenantId, tenantId),
    locationId === null ? isNull(printRoutesTable.locationId) : eq(printRoutesTable.locationId, locationId),
    eq(printRoutesTable.jobType, documentType),
  )).limit(1);
  const values = { printerId: printer!.id, bridgeProfileId: printer!.bridgeProfileId!, isActive: true };
  const [route] = existing
    ? await db.update(printRoutesTable).set(values)
        .where(and(eq(printRoutesTable.tenantId, tenantId), eq(printRoutesTable.id, existing.id))).returning()
    : await db.insert(printRoutesTable).values({ tenantId, locationId, jobType: documentType, ...values }).returning();
  await audit(tenantId, actor, "PRINT_ROUTE_SET", "print_route", String(route!.id), {
    documentType, locationId, printerId: printer!.id, previousPrinterId: existing?.printerId ?? null,
    ...(via ? { via } : {}),
  });
  return { id: route!.id, documentType, locationId, printerId: route!.printerId, bridgeProfileId: route!.bridgeProfileId, isActive: route!.isActive };
}

/**
 * Asks the bridge itself which queues it serves (its server-side allowlist)
 * and requires the queue to be one of them. The bridge key is resolved on the
 * server and never returned.
 */
export async function verifyBridgeQueue(tenantId: number, bridgeProfileId: number, queue: string): Promise<{ bridgeUrl: string; queues: string[] }> {
  const [profile] = await db.select().from(printBridgeProfilesTable).where(and(
    eq(printBridgeProfilesTable.tenantId, tenantId),
    eq(printBridgeProfilesTable.id, bridgeProfileId),
    eq(printBridgeProfilesTable.isActive, true),
  )).limit(1);
  if (!profile) throw new PrintAdminError("Active bridge profile not found in this tenant");
  const { resolveBridgeApiKey } = await import("../printRouter");
  let response: Response;
  try {
    response = await fetch(`${profile.bridgeUrl}/printers`, {
      headers: { "x-api-key": resolveBridgeApiKey(profile.apiKey) },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new PrintAdminError(`Bridge unreachable at ${profile.bridgeUrl}: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (response.status === 401 || response.status === 403) throw new PrintAdminError("Bridge rejected the stored bridge key", 502);
  if (!response.ok) throw new PrintAdminError(`Bridge returned HTTP ${response.status}`, 502);
  const body = await response.json().catch(() => null) as { printerNames?: unknown } | null;
  const queues = Array.isArray(body?.printerNames) ? body!.printerNames.filter((name): name is string => typeof name === "string") : [];
  if (!queues.includes(queue)) throw new PrintAdminError(`Queue "${queue}" is not served by this bridge (bridge allows: ${queues.join(", ") || "none"})`);
  return { bridgeUrl: profile.bridgeUrl, queues };
}
