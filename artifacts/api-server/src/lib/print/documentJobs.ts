/**
 * documentJobs.ts — the one path from a document to a print job.
 *
 *   document data ─► renderer (per printer class) ─► print_jobs row ─► registered printer ─► bridge ─► CUPS
 *
 * The printer comes only from resolveDocumentPrinter (routes, then the
 * thermal legacy fallback); callers never pass a queue. The job is idempotent
 * on its key, and the rendered output matches the chosen printer's class:
 * ESC/POS text for thermal rolls, a PDF for full-page printers.
 */
import { eq } from "drizzle-orm";
import { db, printJobsTable, type PrintJob, type PrintPrinter } from "@workspace/db";
import { encodeStoredReceiptText } from "../receiptRenderer";
import { printerClassOf, thermalColumns, type PrintDocumentType } from "./documentTypes";
import { resolveDocumentPrinter, type RouteSource } from "./printRouting";
import { fitReceiptLines, type ReceiptLine } from "./receiptTemplateRenderer";
import { encodeReceiptEscPos } from "./receiptEncoders";
import { renderReportPdf, type ReportDocument } from "./pdfReport";

export type DocumentRender =
  | { kind: "thermal"; lines: (columns: number) => ReceiptLine[] | Promise<ReceiptLine[]> }
  /** Thermal text rendered for the chosen printer (order receipts from the receipt pipeline). */
  | { kind: "thermal-text"; text: (printer: PrintPrinter, columns: number) => Promise<ThermalText> }
  | { kind: "report"; report: () => ReportDocument | Promise<ReportDocument> };

export interface ThermalText {
  text: string;
  templateId?: number | null;
  templateVersion?: number | null;
}

export interface QueueDocumentInput {
  tenantId: number;
  locationId: number | null;
  shiftId?: number | null;
  orderId?: number | null;
  operatorUserId?: number | null;
  documentType: PrintDocumentType;
  /** print_jobs.job_output, e.g. "shift_clock_in". */
  jobType: string;
  idempotencyKey: string;
  render: DocumentRender;
  /** Non-sensitive metadata kept on the job (never document contents). */
  metadata?: Record<string, unknown>;
  legacyFallback?: () => Promise<PrintPrinter | null>;
  /** Record a failed job when nothing is routed (automatic prints), default true. */
  recordNoRoute?: boolean;
  templateId?: number | null;
  templateVersion?: number | null;
}

export type QueueDocumentResult =
  | { status: "queued"; job: PrintJob; printer: PrintPrinter; source: RouteSource }
  | { status: "duplicate"; job: PrintJob }
  | { status: "no-route"; reason: string; job: PrintJob | null };

export async function renderForPrinter(render: DocumentRender, printer: PrintPrinter): Promise<{
  renderFormat: "text" | "pdf"; renderedText: string; pdfBase64?: string; templateId?: number | null; templateVersion?: number | null;
}> {
  if (render.kind === "report") {
    if (printerClassOf(printer) !== "full_page") throw new Error("Full-page documents cannot print on a thermal printer");
    const report = await render.report();
    const bytes = await renderReportPdf(report);
    return { renderFormat: "pdf", renderedText: `${report.title} (PDF)`, pdfBase64: Buffer.from(bytes).toString("base64") };
  }
  if (printerClassOf(printer) !== "thermal") throw new Error("Thermal documents cannot print on a full-page printer");
  const columns = thermalColumns(printer.paperWidth);
  if (render.kind === "thermal-text") {
    const thermal = await render.text(printer, columns);
    return { renderFormat: "text", renderedText: thermal.text, templateId: thermal.templateId, templateVersion: thermal.templateVersion };
  }
  const lines = fitReceiptLines(await render.lines(columns), columns);
  return { renderFormat: "text", renderedText: encodeStoredReceiptText(encodeReceiptEscPos(lines)) };
}

export async function queueDocumentPrint(input: QueueDocumentInput): Promise<QueueDocumentResult> {
  const [existing] = await db.select().from(printJobsTable).where(eq(printJobsTable.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return { status: "duplicate", job: existing };

  const base = {
    tenantId: input.tenantId,
    locationId: input.locationId,
    shiftId: input.shiftId ?? null,
    orderId: input.orderId ?? null,
    operatorUserId: input.operatorUserId ?? null,
    jobType: input.jobType,
    idempotencyKey: input.idempotencyKey,
    maxRetries: 3,
  };
  const resolution = await resolveDocumentPrinter({
    tenantId: input.tenantId,
    locationId: input.locationId,
    documentType: input.documentType,
    legacyFallback: input.legacyFallback,
  });
  if (!resolution.ok) {
    if (input.recordNoRoute === false) return { status: "no-route", reason: resolution.reason, job: null };
    const [job] = await db.insert(printJobsTable).values({
      ...base, printerId: null, status: "failed", renderFormat: "text", renderedText: "",
      payloadJson: { documentType: input.documentType, ...input.metadata }, errorMessage: resolution.reason,
    }).returning();
    return { status: "no-route", reason: resolution.reason, job: job ?? null };
  }

  const rendered = await renderForPrinter(input.render, resolution.printer);
  // The job's scope is the printer's scope, so the dispatch guard
  // (printerMatchesJobScope) keeps holding on every attempt and retry; the
  // routing location is kept as metadata.
  const printer = resolution.printer;
  const [job] = await db.insert(printJobsTable).values({
    ...base,
    locationId: printer.routingScope === "location" ? printer.locationId : null,
    printerId: printer.id,
    status: "queued",
    renderFormat: rendered.renderFormat,
    renderedText: rendered.renderedText,
    templateId: rendered.templateId ?? input.templateId ?? null,
    templateVersion: rendered.templateVersion ?? input.templateVersion ?? null,
    payloadJson: {
      documentType: input.documentType,
      routeSource: resolution.source,
      routeId: resolution.routeId,
      contextLocationId: input.locationId,
      ...input.metadata,
      ...(rendered.pdfBase64 ? { pdfBase64: rendered.pdfBase64 } : {}),
    },
  }).returning();
  return { status: "queued", job: job!, printer: resolution.printer, source: resolution.source };
}
