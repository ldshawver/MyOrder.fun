/**
 * Operator command: register one location's thermal printer and route its
 * documents to it, through the same rules and audit as the admin screens.
 *
 *   node dist/maintenance-configure-print-location.mjs \
 *       --tenant-id=1 --actor-id=<admin user id> --location-id=4 \
 *       --bridge-id=2 --queue=Beeprt_USB --name="Box 2 Receipt" \
 *       --paper-width=50mm --role=receipt \
 *       --documents=ORDER_RECEIPT,EXPO,CLOCK_IN,CLOCK_OUT,DEPOSIT \
 *       [--deactivate-printer-id=3] [--execute]
 *
 * Without --execute it only checks the plan (actor, location, bridge queue
 * allowlist, document types) and changes nothing. It never prints and never
 * displays a bridge key. Re-running reuses an identical active printer.
 */
import { and, eq } from "drizzle-orm";
import { db, printPrintersTable } from "@workspace/db";
import { DOCUMENT_TYPES, PRINT_DOCUMENT_TYPES, type PrintDocumentType } from "../lib/print/documentTypes";
import { resolveDocumentPrinter } from "../lib/print/printRouting";
import {
  createRegisteredPrinter,
  loadPrintAdminActor,
  printerPaper,
  setDocumentRoute,
  setPrinterActive,
  verifyBridgeQueue,
} from "../lib/print/printerAdmin";

const VIA = "maintenance-configure-print-location";
const arg = (name: string) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};
const required = (name: string) => {
  const value = arg(name)?.trim();
  if (!value) throw new Error(`--${name}=<value> is required`);
  return value;
};
const id = (name: string) => {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name}=<positive integer> is required`);
  return value;
};

const execute = process.argv.includes("--execute");
const tenantId = id("tenant-id");
const locationId = id("location-id");
const bridgeId = id("bridge-id");
const queue = required("queue");
const name = required("name");
const role = required("role");
const paper = printerPaper("thermal", required("paper-width"));
if ("error" in paper) throw new Error(paper.error);
const deactivateId = arg("deactivate-printer-id") ? id("deactivate-printer-id") : null;
const documents = required("documents").split(",").map((value) => value.trim()) as PrintDocumentType[];
for (const documentType of documents) {
  if (!(PRINT_DOCUMENT_TYPES as readonly string[]).includes(documentType)) throw new Error(`Unknown document type ${documentType}`);
  if (DOCUMENT_TYPES[documentType].printerClass !== "thermal") throw new Error(`${documentType} needs a full-page printer, not this thermal printer`);
}

const actor = await loadPrintAdminActor(tenantId, id("actor-id"));
const bridge = await verifyBridgeQueue(tenantId, bridgeId, queue);
const tenantPrinter = async (printerId: number) =>
  (await db.select().from(printPrintersTable).where(and(eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.id, printerId))).limit(1))[0] ?? null;
const oldPrinter = deactivateId ? await tenantPrinter(deactivateId) : null;
if (deactivateId && !oldPrinter) throw new Error(`Printer ${deactivateId} not found in this tenant`);

const summary: Record<string, unknown> = {
  mode: execute ? "execute" : "check",
  tenantId, locationId, bridgeId, queue, bridgeQueues: bridge.queues,
  printer: { name, role, printerClass: "thermal", paperWidth: paper.paperWidth },
  documents,
};
if (!execute) {
  console.log(JSON.stringify({ ...summary, deactivate: oldPrinter ? { id: oldPrinter.id, isActive: oldPrinter.isActive } : null }));
  process.exit(0);
}

if (oldPrinter?.isActive) await setPrinterActive(tenantId, actor, oldPrinter.id, false, VIA);

const [existing] = await db.select().from(printPrintersTable).where(and(
  eq(printPrintersTable.tenantId, tenantId),
  eq(printPrintersTable.locationId, locationId),
  eq(printPrintersTable.bridgeProfileId, bridgeId),
  eq(printPrintersTable.bridgePrinterName, queue),
  eq(printPrintersTable.printerClass, "thermal"),
  eq(printPrintersTable.paperWidth, paper.paperWidth),
  eq(printPrintersTable.role, role),
  eq(printPrintersTable.isActive, true),
)).limit(1);
const printer = existing ?? await createRegisteredPrinter(tenantId, actor, {
  name, role, connectionType: "bridge", printerClass: "thermal", paperWidth: paper.paperWidth,
  locationId, bridgeProfileId: bridgeId, bridgePrinterName: queue, copies: 1, isActive: true,
}, VIA);

const routes = [];
for (const documentType of documents) routes.push(await setDocumentRoute(tenantId, actor, { documentType, locationId, printerId: printer.id }, VIA));

// What production will actually resolve: routes only, no legacy fallback.
const resolved: Record<string, unknown> = {};
for (const documentType of PRINT_DOCUMENT_TYPES) {
  const result = await resolveDocumentPrinter({ tenantId, locationId, documentType });
  resolved[documentType] = result.ok ? { printerId: result.printer.id, source: result.source, routeId: result.routeId } : { none: result.reason };
}
const old = oldPrinter ? await tenantPrinter(oldPrinter.id) : null;
console.log(JSON.stringify({
  ...summary,
  deactivated: old ? { id: old.id, isActive: old.isActive } : null,
  printer: { id: printer.id, reused: Boolean(existing), name: printer.name, role: printer.role, printerClass: printer.printerClass, paperWidth: printer.paperWidth, locationId: printer.locationId, routingScope: printer.routingScope, bridgeProfileId: printer.bridgeProfileId, queue: printer.bridgePrinterName, isActive: printer.isActive },
  routes,
  resolved,
}));
process.exit(0);
