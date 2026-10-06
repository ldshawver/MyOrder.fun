/**
 * /api/print/* — printing configuration and documents (admin).
 *
 *   GET    /print/document-types             catalogue: type, label, printer class
 *   GET    /print/routes                     tenant routes
 *   PUT    /print/routes                     set the printer for (location|default, document type)
 *   DELETE /print/routes/:id                 remove a document route
 *   GET    /print/routing-matrix             what prints where, per location and document type
 *   POST   /print/documents/preview          sample document (text or PDF), never printed
 *   POST   /print/documents/test             sample document on one explicit registered printer
 *   GET    /print/inventory/stock-list.pdf   full-page stock list for a location
 *   POST   /print/inventory/stock-list/print routed full-page stock list
 *   GET    /print/reports/sales-tax.pdf      full-page sales tax report
 *   POST   /print/reports/sales-tax/print    routed full-page sales tax report
 *
 * Tenant comes from the signed-in admin only. Printers and queues are never
 * taken from the request except as ids of this tenant's registered printers.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditLogsTable,
  inventoryLocationsTable,
  printBridgeProfilesTable,
  printJobsTable,
  printPrintersTable,
  printRoutesTable,
  printTemplatesTable,
  printTemplateVersionsTable,
  type PrintPrinter,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { getTenantSettings } from "../config/tenantConfig";
import { getCatalogInventorySnapshot } from "../lib/inventoryBalances";
import { dispatchJob } from "../lib/printService";
import { resolveReceiptPrinters } from "../lib/printRouter";
import {
  DOCUMENT_TYPES,
  PRINT_DOCUMENT_TYPES,
  thermalColumns,
  type PrintDocumentType,
} from "../lib/print/documentTypes";
import { resolveDocumentPrinter, validatePrinterForDocument } from "../lib/print/printRouting";
import { queueDocumentPrint, renderForPrinter, type DocumentRender } from "../lib/print/documentJobs";
import { buildStockList, sampleDocument, type StockListRow } from "../lib/print/documents";
import { renderReportPdf, type ReportDocument } from "../lib/print/pdfReport";
import { fitReceiptLines, type ReceiptLine } from "../lib/print/receiptTemplateRenderer";
import { encodeReceiptPlain } from "../lib/print/receiptEncoders";
import { formatMoney, SAMPLE_RECEIPT_DATA, toCents } from "../lib/print/receiptData";
import { RECEIPT_DATA_FIELDS, receiptTemplateLayoutSchema } from "../lib/printTemplateSchema";
import { UNSUPPORTED_RECEIPT_FIELDS } from "../lib/print/receiptTemplateRenderer";
import {
  loadLegacyReceiptPresentation,
  renderReceipt,
  resolveTenantReceiptTemplate,
  type ReceiptTemplateRecord,
} from "../lib/print/receiptPipeline";
import { salesTaxReport } from "./reports";
import { PrintAdminError, setDocumentRoute } from "../lib/print/printerAdmin";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);
const adminOnly = requireRole("global_admin", "admin");

const tenantOf = (req: Request): number => {
  const tenantId = req.dbUser?.tenantId;
  if (!tenantId) throw new Error("Approved tenant membership is required");
  return tenantId;
};
const documentTypeSchema = z.enum(PRINT_DOCUMENT_TYPES);
const idSchema = z.number().int().positive();
const badRequest = (res: Response, error: string, issues?: unknown) => res.status(400).json({ error, ...(issues ? { issues } : {}) });

async function audit(req: Request, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  await db.insert(auditLogsTable).values({
    tenantId: tenantOf(req),
    actorId: req.dbUser!.id,
    actorEmail: req.dbUser!.email ?? "",
    actorRole: req.dbUser!.role,
    action,
    resourceType,
    resourceId,
    metadata,
  });
}

async function tenantLocation(tenantId: number, locationId: number) {
  const [location] = await db.select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name })
    .from(inventoryLocationsTable)
    .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.isActive, true)))
    .limit(1);
  return location ?? null;
}

async function tenantPrinter(tenantId: number, printerId: number): Promise<PrintPrinter | null> {
  const [printer] = await db.select().from(printPrintersTable)
    .where(and(eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.id, printerId))).limit(1);
  return printer ?? null;
}

// ── Catalogue and routes ──────────────────────────────────────────────────────

router.get("/print/document-types", adminOnly, (_req, res): void => {
  res.json({
    documentTypes: PRINT_DOCUMENT_TYPES.map((type) => ({ type, ...DOCUMENT_TYPES[type] })),
  });
});

router.get("/print/routes", adminOnly, async (req, res): Promise<void> => {
  const tenantId = tenantOf(req);
  const routes = await db.select({
    id: printRoutesTable.id,
    locationId: printRoutesTable.locationId,
    documentType: printRoutesTable.jobType,
    printerId: printRoutesTable.printerId,
    bridgeProfileId: printRoutesTable.bridgeProfileId,
    isActive: printRoutesTable.isActive,
  }).from(printRoutesTable).where(eq(printRoutesTable.tenantId, tenantId));
  res.json({ routes: routes.filter((route) => (PRINT_DOCUMENT_TYPES as readonly string[]).includes(route.documentType)) });
});

const setRouteSchema = z.object({
  documentType: documentTypeSchema,
  /** null = tenant-wide default for this document type. */
  locationId: idSchema.nullable(),
  printerId: idSchema,
}).strict();

router.put("/print/routes", adminOnly, async (req, res): Promise<void> => {
  const parsed = setRouteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid route", parsed.error.issues.slice(0, 10)); return; }
  try {
    res.json({ route: await setDocumentRoute(tenantOf(req), req.dbUser!, parsed.data) });
  } catch (err) {
    if (!(err instanceof PrintAdminError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

router.delete("/print/routes/:id", adminOnly, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { badRequest(res, "Invalid route id"); return; }
  const tenantId = tenantOf(req);
  const [route] = await db.select().from(printRoutesTable)
    .where(and(eq(printRoutesTable.tenantId, tenantId), eq(printRoutesTable.id, id))).limit(1);
  if (!route || !(PRINT_DOCUMENT_TYPES as readonly string[]).includes(route.jobType)) {
    res.status(404).json({ error: "Route not found" }); return;
  }
  await db.update(printRoutesTable).set({ isActive: false })
    .where(and(eq(printRoutesTable.tenantId, tenantId), eq(printRoutesTable.id, id)));
  await audit(req, "PRINT_ROUTE_REMOVED", "print_route", String(id), { documentType: route.jobType, locationId: route.locationId, printerId: route.printerId });
  res.json({ ok: true });
});

router.get("/print/routing-matrix", adminOnly, async (req, res): Promise<void> => {
  const tenantId = tenantOf(req);
  const locations = await db.select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name })
    .from(inventoryLocationsTable)
    .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true)));
  const printers = await db.select().from(printPrintersTable).where(eq(printPrintersTable.tenantId, tenantId));
  const bridges = await db.select({ id: printBridgeProfilesTable.id, name: printBridgeProfilesTable.name })
    .from(printBridgeProfilesTable).where(eq(printBridgeProfilesTable.tenantId, tenantId));
  const bridgeName = new Map(bridges.map((bridge) => [bridge.id, bridge.name]));
  const generalReceipt = async () => (await resolveReceiptPrinters(null, { tenantId, locationId: null, shiftId: null })).primary;
  const cells = [];
  for (const location of [{ id: null as number | null, name: "Default (all locations)" }, ...locations]) {
    for (const documentType of PRINT_DOCUMENT_TYPES) {
      const legacy = ["ORDER_RECEIPT", "CLOCK_IN", "CLOCK_OUT", "DEPOSIT"].includes(documentType) ? generalReceipt : undefined;
      const resolution = await resolveDocumentPrinter({ tenantId, locationId: location.id, documentType, legacyFallback: legacy });
      const printer = resolution.ok ? printers.find((row) => row.id === resolution.printer.id) : undefined;
      cells.push({
        locationId: location.id,
        documentType,
        printerId: printer?.id ?? null,
        printerName: printer?.name ?? null,
        bridgeName: printer?.bridgeProfileId ? bridgeName.get(printer.bridgeProfileId) ?? null : null,
        source: resolution.ok ? resolution.source : null,
        problem: resolution.ok ? null : resolution.reason,
      });
    }
  }
  res.json({ locations: [{ id: null, name: "Default (all locations)" }, ...locations], documentTypes: PRINT_DOCUMENT_TYPES, cells });
});

// ── Previews and test prints (synthetic data only) ────────────────────────────

const TEST_BANNER = ["*** TEST PRINT ***", "SAMPLE DATA - NOT A SALE"];

function testThermal(lines: ReceiptLine[]): ReceiptLine[] {
  return [
    ...TEST_BANNER.map((text): ReceiptLine => ({ kind: "text", text, align: "center", bold: true, size: "normal" })),
    { kind: "rule", style: "double" },
    ...lines,
  ];
}

function testReport(report: ReportDocument): ReportDocument {
  return { ...report, title: `TEST - ${report.title}`, footerNote: "TEST PRINT - SAMPLE DATA - NOT A BUSINESS RECORD" };
}

async function receiptTemplateFor(req: Request, body: { templateId?: number; templateJson?: unknown }): Promise<ReceiptTemplateRecord | null | "not-found" | "invalid"> {
  const tenantId = tenantOf(req);
  if (body.templateJson !== undefined) {
    const parsed = receiptTemplateLayoutSchema.safeParse(body.templateJson);
    return parsed.success ? { id: 0, version: 0, paperWidth: "80mm", layout: parsed.data } : "invalid";
  }
  if (body.templateId !== undefined) {
    const [row] = await db.select({
      id: printTemplatesTable.id, version: printTemplatesTable.version,
      paperWidth: printTemplatesTable.paperWidth, layout: printTemplatesTable.templateJson,
    }).from(printTemplatesTable).where(and(
      eq(printTemplatesTable.tenantId, tenantId), eq(printTemplatesTable.id, body.templateId), eq(printTemplatesTable.jobType, "receipt"),
    )).limit(1);
    return row ?? "not-found";
  }
  return resolveTenantReceiptTemplate(tenantId);
}

/** Sample render for a document type on a printer class/width. */
async function sampleRender(req: Request, documentType: PrintDocumentType, template: ReceiptTemplateRecord | null, testBanner: boolean): Promise<DocumentRender> {
  if (documentType === "ORDER_RECEIPT") {
    const presentation = await loadLegacyReceiptPresentation(tenantOf(req));
    return {
      kind: "thermal-text",
      text: async (_printer, columns) => {
        const receipt = renderReceipt(SAMPLE_RECEIPT_DATA, template, presentation, "escpos", columns);
        const banner = testBanner ? `${TEST_BANNER.join("\n")}\n\n` : "";
        // Both receipt paths start with ESC @ (initialise); the banner follows it.
        return { text: receipt.text.replace(/^\x1b@/, `\x1b@${banner}`), templateId: receipt.templateId || null, templateVersion: receipt.templateVersion || null }; // eslint-disable-line no-control-regex -- matching the init command
      },
    };
  }
  const sample = sampleDocument(documentType);
  if (sample.kind === "report") return { kind: "report", report: () => (testBanner ? testReport(sample.report) : sample.report) };
  return { kind: "thermal", lines: () => (testBanner ? testThermal(sample.lines) : sample.lines) };
}

const previewSchema = z.object({
  documentType: documentTypeSchema,
  paperWidth: z.enum(["50mm", "80mm"]).optional(),
  templateId: idSchema.optional(),
  templateJson: z.unknown().optional(),
}).strict();

router.post("/print/documents/preview", adminOnly, async (req, res): Promise<void> => {
  const parsed = previewSchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid preview request", parsed.error.issues.slice(0, 10)); return; }
  const { documentType, paperWidth } = parsed.data;
  const template = documentType === "ORDER_RECEIPT" ? await receiptTemplateFor(req, parsed.data) : null;
  if (template === "invalid") { badRequest(res, "Invalid receipt template"); return; }
  if (template === "not-found") { res.status(404).json({ error: "Receipt template not found" }); return; }
  const render = await sampleRender(req, documentType, template, false);
  if (render.kind === "report") {
    const pdf = await renderReportPdf(await render.report());
    res.type("application/pdf").set("Content-Disposition", "inline; filename=\"preview.pdf\"").send(Buffer.from(pdf));
    return;
  }
  const columns = thermalColumns(paperWidth ?? "80mm");
  let text: string;
  if (documentType === "ORDER_RECEIPT") {
    // Same receipt engine, plain-text encoder (no printer bytes).
    text = renderReceipt(SAMPLE_RECEIPT_DATA, template as ReceiptTemplateRecord | null, await loadLegacyReceiptPresentation(tenantOf(req)), "plain", columns).text;
  } else if (render.kind === "thermal") {
    text = encodeReceiptPlain(fitReceiptLines(await render.lines(columns), columns));
  } else {
    badRequest(res, "Unsupported preview"); return;
  }
  res.type("text/plain").send(`*** SAMPLE / PREVIEW - NOT PRINTED ***\n\n${text}`);
});

const testSchema = z.object({
  documentType: documentTypeSchema,
  printerId: idSchema,
  testId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  templateId: idSchema.optional(),
  templateJson: z.unknown().optional(),
}).strict();

router.post("/print/documents/test", adminOnly, async (req, res): Promise<void> => {
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid test print request", parsed.error.issues.slice(0, 10)); return; }
  const tenantId = tenantOf(req);
  const { documentType, printerId } = parsed.data;
  const printer = await tenantPrinter(tenantId, printerId);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }
  const problem = await validatePrinterForDocument(printer, { tenantId, locationId: printer.locationId, documentType });
  if (problem) { res.status(409).json({ error: `This printer cannot print ${documentType}: ${problem}` }); return; }
  const template = documentType === "ORDER_RECEIPT" ? await receiptTemplateFor(req, parsed.data) : null;
  if (template === "invalid") { badRequest(res, "Invalid receipt template"); return; }
  if (template === "not-found") { res.status(404).json({ error: "Receipt template not found" }); return; }

  const testId = parsed.data.testId ?? `test-${Date.now()}`;
  const rendered = await renderForPrinter(await sampleRender(req, documentType, template, true), printer);
  const [job] = await db.insert(printJobsTable).values({
    tenantId,
    locationId: printer.routingScope === "location" ? printer.locationId : null,
    printerId: printer.id,
    jobType: "document_test",
    status: "queued",
    idempotencyKey: `document_test:${tenantId}:${printer.id}:${documentType}:${testId}`,
    renderFormat: rendered.renderFormat,
    renderedText: rendered.renderedText,
    templateId: rendered.templateId ?? null,
    templateVersion: rendered.templateVersion ?? null,
    maxRetries: 1,
    payloadJson: { documentType, controlledTest: true, testId, ...(rendered.pdfBase64 ? { pdfBase64: rendered.pdfBase64 } : {}) },
  }).returning();
  await audit(req, "PRINT_DOCUMENT_TEST_SUBMITTED", "print_job", String(job!.id), { documentType, printerId: printer.id, testId });
  await dispatchJob(job!, printer).catch(() => {});
  const [finalJob] = await db.select().from(printJobsTable)
    .where(and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, job!.id))).limit(1);
  const ok = finalJob?.status === "printed";
  res.json({ ok, jobId: job!.id, status: finalJob?.status ?? "unknown", testId, error: ok ? undefined : finalJob?.errorMessage ?? "Test print did not complete" });
});

// ── Receipt designer support ──────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  businessName: "Business name", businessAddress: "Business address", businessPhone: "Business phone",
  orderNumber: "Order number", dateTime: "Date and time", csr: "Employee", customerSafeName: "Customer (first name + initial)",
  customerName: "Customer (full name)", items: "Items", subtotal: "Subtotal", discounts: "Discounts", salesTax: "Sales tax",
  tenderType: "Payment / tender", paymentReference: "Payment reference (masked)", total: "Total", cashReceived: "Cash received",
  change: "Change", thankYou: "Thank-you line",
};

/** The fields the receipt engine renders today; the designer offers only these. */
router.get("/print/templates/receipt-fields", adminOnly, (_req, res): void => {
  res.json({
    fields: RECEIPT_DATA_FIELDS.filter((field) => !UNSUPPORTED_RECEIPT_FIELDS.has(field))
      .map((field) => ({ field, label: FIELD_LABELS[field] ?? field })),
    itemOptions: ["showOption", "showSku", "showUnitPrice", "showItemNotes"],
    paperWidths: ["50mm", "80mm"],
  });
});

async function tenantTemplate(tenantId: number, id: number) {
  const [row] = await db.select().from(printTemplatesTable)
    .where(and(eq(printTemplatesTable.tenantId, tenantId), eq(printTemplatesTable.id, id))).limit(1);
  return row ?? null;
}

router.get("/print/templates/:id/versions", adminOnly, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tenantId = tenantOf(req);
  if (!Number.isInteger(id) || !(await tenantTemplate(tenantId, id))) { res.status(404).json({ error: "Template not found" }); return; }
  const versions = await db.select({
    version: printTemplateVersionsTable.version,
    paperWidth: printTemplateVersionsTable.paperWidth,
    createdAt: printTemplateVersionsTable.createdAt,
    createdByUserId: printTemplateVersionsTable.createdByUserId,
  }).from(printTemplateVersionsTable).where(and(
    eq(printTemplateVersionsTable.tenantId, tenantId), eq(printTemplateVersionsTable.templateId, id),
  )).orderBy(desc(printTemplateVersionsTable.version));
  res.json({ versions });
});

router.post("/print/templates/:id/versions/:version/restore", adminOnly, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const version = Number(req.params.version);
  const tenantId = tenantOf(req);
  const template = Number.isInteger(id) ? await tenantTemplate(tenantId, id) : null;
  if (!template || !Number.isInteger(version)) { res.status(404).json({ error: "Template not found" }); return; }
  const [snapshot] = await db.select().from(printTemplateVersionsTable).where(and(
    eq(printTemplateVersionsTable.tenantId, tenantId), eq(printTemplateVersionsTable.templateId, id), eq(printTemplateVersionsTable.version, version),
  )).limit(1);
  if (!snapshot) { res.status(404).json({ error: "Version not found" }); return; }
  const layout = receiptTemplateLayoutSchema.safeParse(snapshot.templateJson);
  if (!layout.success) { res.status(409).json({ error: "That version is not valid under the current receipt rules and cannot be restored" }); return; }
  // Restoring saves the old layout as a new version; history is never rewritten.
  const nextVersion = template.version + 1;
  const [updated] = await db.update(printTemplatesTable)
    .set({ templateJson: layout.data, paperWidth: snapshot.paperWidth, version: nextVersion })
    .where(and(eq(printTemplatesTable.tenantId, tenantId), eq(printTemplatesTable.id, id))).returning();
  await db.insert(printTemplateVersionsTable).values({
    tenantId, templateId: id, version: nextVersion, schemaVersion: template.schemaVersion, templateJson: layout.data,
    backgroundAssetId: template.backgroundAssetId, paperWidth: snapshot.paperWidth, paperHeight: template.paperHeight, createdByUserId: req.dbUser!.id,
  });
  await audit(req, "PRINT_TEMPLATE_RESTORED", "print_template", String(id), { restoredVersion: version, newVersion: nextVersion });
  res.json({ template: updated });
});

// ── Full-page stock list and reports ──────────────────────────────────────────

async function stockListReport(req: Request, locationId: number): Promise<ReportDocument | null> {
  const tenantId = tenantOf(req);
  const location = await tenantLocation(tenantId, locationId);
  if (!location) return null;
  const snapshot = await getCatalogInventorySnapshot(tenantId);
  const tenant = await getTenantSettings(tenantId);
  const rows: StockListRow[] = snapshot.items.flatMap((item) => {
    const here = item.locations.find((entry) => entry.locationId === location.id);
    if (!here) return [];
    return [{ name: item.name, sku: item.sku, option: null, unit: item.stockUnit || null, quantity: here.qty, par: here.par || null }];
  }).sort((a, b) => a.name.localeCompare(b.name));
  return buildStockList({
    businessName: tenant?.business.publicBusinessName ?? "MyOrder.fun",
    locationName: location.name,
    generatedAt: new Date().toISOString(),
    timezone: tenant?.business.timezone ?? "America/Los_Angeles",
    generatedBy: [req.dbUser?.firstName, req.dbUser?.lastName?.charAt(0)].filter(Boolean).join(" ") || null,
    rows,
  });
}

const locationQuery = z.object({ locationId: z.coerce.number().int().positive() }).strict();

router.get("/print/inventory/stock-list.pdf", adminOnly, async (req, res): Promise<void> => {
  const parsed = locationQuery.safeParse(req.query);
  if (!parsed.success) { badRequest(res, "locationId is required"); return; }
  const report = await stockListReport(req, parsed.data.locationId);
  if (!report) { res.status(404).json({ error: "Location not found" }); return; }
  res.type("application/pdf").set("Content-Disposition", "attachment; filename=\"stock-list.pdf\"").send(Buffer.from(await renderReportPdf(report)));
});

async function printRouted(req: Request, res: Response, input: { documentType: PrintDocumentType; jobType: string; locationId: number | null; report: ReportDocument; key: string }) {
  const tenantId = tenantOf(req);
  const result = await queueDocumentPrint({
    tenantId, locationId: input.locationId, documentType: input.documentType, jobType: input.jobType,
    operatorUserId: req.dbUser!.id, idempotencyKey: `${input.jobType}:${tenantId}:${input.key}:${req.dbUser!.id}:${Date.now()}`,
    render: { kind: "report", report: () => input.report }, recordNoRoute: false, metadata: { manual: true },
  });
  if (result.status !== "queued") { res.status(503).json({ error: result.status === "no-route" ? result.reason : "Duplicate request" }); return; }
  await audit(req, "PRINT_DOCUMENT_REQUESTED", "print_job", String(result.job.id), { documentType: input.documentType, printerId: result.printer.id, locationId: input.locationId });
  await dispatchJob(result.job, result.printer).catch(() => {});
  const [finalJob] = await db.select().from(printJobsTable)
    .where(and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, result.job.id))).limit(1);
  const ok = finalJob?.status === "printed";
  res.status(ok ? 200 : 502).json({ ok, jobId: result.job.id, status: finalJob?.status ?? "unknown", printerName: result.printer.name, error: ok ? undefined : finalJob?.errorMessage });
}

router.post("/print/inventory/stock-list/print", adminOnly, async (req, res): Promise<void> => {
  const parsed = z.object({ locationId: idSchema }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "locationId is required"); return; }
  const report = await stockListReport(req, parsed.data.locationId);
  if (!report) { res.status(404).json({ error: "Location not found" }); return; }
  await printRouted(req, res, { documentType: "INVENTORY_STOCK_LIST", jobType: "inventory_stock_list", locationId: parsed.data.locationId, report, key: `location-${parsed.data.locationId}` });
});

const taxQuery = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  locationId: z.string().regex(/^\d+$/).optional(),
}).strict();

async function salesTaxDocument(req: Request, query: z.infer<typeof taxQuery>): Promise<ReportDocument> {
  const tenantId = tenantOf(req);
  const report = await salesTaxReport(tenantId, query);
  const tenant = await getTenantSettings(tenantId);
  const money = (value: unknown) => formatMoney(toCents(value));
  return {
    title: "Sales Tax Report",
    businessName: tenant?.business.publicBusinessName ?? "MyOrder.fun",
    generatedAt: new Date().toISOString(),
    timezone: tenant?.business.timezone ?? "America/Los_Angeles",
    generatedBy: [req.dbUser?.firstName, req.dbUser?.lastName?.charAt(0)].filter(Boolean).join(" ") || null,
    rangeLabel: `${query.dateFrom ?? "All dates"} to ${query.dateTo ?? "today"}`,
    summary: [
      { label: "Gross sales", value: money(report.grossSales) },
      { label: "Taxable sales", value: money(report.taxableSales) },
      { label: "Tax collected", value: money(report.salesTaxCollected) },
      { label: "Tax refunded", value: money(report.salesTaxRefunded) },
      { label: "Net tax liability", value: money(report.netSalesTaxLiability) },
      { label: "Reconciled", value: report.reconciled ? "Yes" : "No" },
    ],
    sections: [
      {
        heading: "By jurisdiction",
        columns: [{ key: "jurisdiction", label: "Jurisdiction", weight: 3 }, { key: "rate", label: "Rate", align: "right" }, { key: "taxable", label: "Taxable", align: "right" }, { key: "collected", label: "Collected", align: "right" }, { key: "refunded", label: "Refunded", align: "right" }],
        rows: report.jurisdictions.map((row) => ({
          jurisdiction: row.jurisdiction, rate: `${(row.taxRate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`,
          taxable: money(row.taxableAmount), collected: money(row.taxCollected), refunded: money(row.taxRefunded),
        })),
        totals: { jurisdiction: "Total", taxable: money(report.taxableAmount), collected: money(report.salesTaxCollected), refunded: money(report.salesTaxRefunded) },
        emptyText: "No taxable sales in this range",
      },
      {
        heading: "Transactions",
        columns: [{ key: "order", label: "Order" }, { key: "method", label: "Payment", weight: 2 }, { key: "total", label: "Total", align: "right" }, { key: "collected", label: "Tax collected", align: "right" }, { key: "refunded", label: "Tax refunded", align: "right" }],
        rows: report.transactions.map((row) => ({ order: `#${row.orderId}`, method: row.paymentMethod, total: money(row.total), collected: money(row.taxCollected), refunded: money(row.taxRefunded) })),
        emptyText: "No transactions in this range",
      },
    ],
  };
}

router.get("/print/reports/sales-tax.pdf", adminOnly, async (req, res): Promise<void> => {
  const parsed = taxQuery.safeParse(req.query);
  if (!parsed.success) { badRequest(res, "Invalid report range"); return; }
  try {
    const document = await salesTaxDocument(req, parsed.data);
    res.type("application/pdf").set("Content-Disposition", "attachment; filename=\"sales-tax-report.pdf\"").send(Buffer.from(await renderReportPdf(document)));
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message });
  }
});

router.post("/print/reports/sales-tax/print", adminOnly, async (req, res): Promise<void> => {
  const parsed = taxQuery.extend({ printLocationId: idSchema.nullable().optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid report request"); return; }
  const { printLocationId = null, ...query } = parsed.data;
  if (printLocationId !== null && !(await tenantLocation(tenantOf(req), printLocationId))) { badRequest(res, "Active location not found in this tenant"); return; }
  try {
    const document = await salesTaxDocument(req, query);
    await printRouted(req, res, { documentType: "REPORT", jobType: "report", locationId: printLocationId, report: document, key: "sales-tax" });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message });
  }
});

export default router;
