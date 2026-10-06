/**
 * printRouting.ts — deterministic document → registered printer resolution.
 *
 * For (tenant, location, document type) exactly one printer is chosen:
 *   1. the active route for that location and document type;
 *   2. else the tenant-wide default route (location NULL) for the type;
 *   3. else, for thermal documents only, the caller's legacy resolver
 *      (existing receipt/expo assignment), so nothing that prints today
 *      silently stops;
 *   4. else nothing: the caller records "no route" and does not print.
 *
 * A route that exists but is misconfigured (wrong printer class, inactive or
 * foreign printer/bridge, location printer used for another location) fails
 * closed and never falls through to another printer. Jobs are never fanned
 * out to every printer with a role.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, printRoutesTable, printPrintersTable, printBridgeProfilesTable, type PrintPrinter } from "@workspace/db";
import { DOCUMENT_TYPES, printerClassOf, type PrintDocumentType } from "./documentTypes";

export type RouteSource = "location-route" | "tenant-route" | "legacy-fallback";

export type RouteResolution =
  | { ok: true; printer: PrintPrinter; source: RouteSource; routeId: number | null }
  | { ok: false; reason: string };

export interface RouteContext {
  tenantId: number;
  locationId: number | null;
  documentType: PrintDocumentType;
  /** Existing resolution used only when no route is configured (thermal only). */
  legacyFallback?: () => Promise<PrintPrinter | null>;
}

type RouteRow = typeof printRoutesTable.$inferSelect;

async function findRoute(tenantId: number, locationId: number | null, documentType: PrintDocumentType): Promise<RouteRow | null> {
  const [row] = await db.select().from(printRoutesTable).where(and(
    eq(printRoutesTable.tenantId, tenantId),
    locationId === null ? isNull(printRoutesTable.locationId) : eq(printRoutesTable.locationId, locationId),
    eq(printRoutesTable.jobType, documentType),
    eq(printRoutesTable.isActive, true),
  )).limit(1);
  return row ?? null;
}

/**
 * Checks that a printer may print this document type for this location.
 * Returns null when valid, or the reason it is not.
 */
export async function validatePrinterForDocument(
  printer: PrintPrinter | null | undefined,
  context: { tenantId: number; locationId: number | null; documentType: PrintDocumentType; bridgeProfileId?: number | null },
): Promise<string | null> {
  if (!printer || printer.tenantId !== context.tenantId) return "printer not found in this tenant";
  if (!printer.isActive) return "printer is inactive";
  const needed = DOCUMENT_TYPES[context.documentType].printerClass;
  if (printerClassOf(printer) !== needed) return `${context.documentType} needs a ${needed === "full_page" ? "full-page" : "thermal"} printer`;
  if (printer.routingScope === "location" && printer.locationId !== context.locationId) {
    return "printer belongs to a different location";
  }
  if (!printer.bridgeProfileId) return "printer has no registered bridge";
  if (context.bridgeProfileId != null && context.bridgeProfileId !== printer.bridgeProfileId) {
    return "route bridge does not match the printer's bridge";
  }
  const [bridge] = await db.select({ id: printBridgeProfilesTable.id }).from(printBridgeProfilesTable).where(and(
    eq(printBridgeProfilesTable.tenantId, context.tenantId),
    eq(printBridgeProfilesTable.id, printer.bridgeProfileId),
    eq(printBridgeProfilesTable.isActive, true),
  )).limit(1);
  if (!bridge) return "printer's bridge is inactive or not in this tenant";
  return null;
}

async function printerFromRoute(route: RouteRow, context: RouteContext): Promise<RouteResolution> {
  const [printer] = await db.select().from(printPrintersTable).where(and(
    eq(printPrintersTable.tenantId, context.tenantId),
    eq(printPrintersTable.id, route.printerId),
  )).limit(1);
  const problem = await validatePrinterForDocument(printer, { ...context, bridgeProfileId: route.bridgeProfileId });
  if (problem) return { ok: false, reason: `Route ${route.id} is misconfigured: ${problem}` };
  return { ok: true, printer: printer!, source: route.locationId === null ? "tenant-route" : "location-route", routeId: route.id };
}

export async function resolveDocumentPrinter(context: RouteContext): Promise<RouteResolution> {
  const routes = [
    context.locationId !== null ? await findRoute(context.tenantId, context.locationId, context.documentType) : null,
    await findRoute(context.tenantId, null, context.documentType),
  ];
  const route = routes.find((candidate): candidate is RouteRow => candidate !== null);
  if (route) return printerFromRoute(route, context);

  if (DOCUMENT_TYPES[context.documentType].printerClass === "thermal" && context.legacyFallback) {
    const printer = await context.legacyFallback();
    const problem = printer ? await validatePrinterForDocument(printer, context) : "no printer";
    if (printer && !problem) return { ok: true, printer, source: "legacy-fallback", routeId: null };
  }
  return { ok: false, reason: `No print route for ${context.documentType}${context.locationId !== null ? ` at location ${context.locationId}` : ""}` };
}
