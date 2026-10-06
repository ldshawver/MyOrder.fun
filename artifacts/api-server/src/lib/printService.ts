/**
 * printService.ts — Production print dispatch with operator selection,
 * ethernet direct, and HTTP bridge support, queue + retry.
 *
 * Receipt flow:  ethernet_direct → bridge (resolved by printRouter) → queue
 * Label flow:    bridge (resolved by printRoutingResolver) → queue
 *
 * Bridge selection (which bridge URL/key to use) is determined by:
 *   - Receipts: resolveReceiptPrinters() → picks printer by role + connectionType
 *   - Labels:   resolveRoutingDecision() → picks printer by bridge profile + health + network
 */

import crypto from "crypto";
import net from "net";
import { db } from "@workspace/db";
import {
  printPrintersTable,
  printBridgeProfilesTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
  adminSettingsTable,
  shiftPrintAssignmentsTable,
} from "@workspace/db";
import { eq, and, inArray, lt, sql } from "drizzle-orm";
import { decodeStoredReceiptText, renderCustomerReceipt } from "./receiptRenderer";
import { charWidth, getLogo } from "./print/index";
import { generateThankYouLabel } from "./print/templates/thankYouLabel.js";
import {
  selectActiveOperator,
  resolveReceiptPrinters,
  resolveLabelPrinter,
  resolveExpoPrinter,
} from "./printRouter";
import type { PrintJob, PrintPrinter } from "@workspace/db";
import { logger as _logger } from "./logger";
import { getPrintControls } from "./printControls";
import { getBranding } from "../config/brandingConfig";

const pLog = _logger.child({ module: "printService" });

// ── Idempotency ───────────────────────────────────────────────────────────────

export function makeIdempotencyKey(orderId: number, printerId: number, jobType: string): string {
  return crypto
    .createHash("sha256")
    .update(`${orderId}:${printerId}:${jobType}`)
    .digest("hex");
}

// ── Settings ──────────────────────────────────────────────────────────────────

let printSettingsSchemaEnsured = false;

async function ensurePrintSettingsSchema(): Promise<void> {
  if (printSettingsSchemaEnsured) return;
  await db.execute(sql`ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "receipt_template_style" text NOT NULL DEFAULT 'clean'`);
  await db.execute(sql`ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "label_template_style" text NOT NULL DEFAULT 'thank_you_personalized'`);
  printSettingsSchemaEnsured = true;
}

export async function getSettings() {
  await ensurePrintSettingsSchema();
  const rows = await db.select().from(printSettingsTable).limit(1);
  if (rows.length) return rows[0];
  const [created] = await db.insert(printSettingsTable).values({}).returning();
  return created;
}

// ── Job Creation ──────────────────────────────────────────────────────────────

export async function createPrintJob(opts: {
  tenantId: number;
  locationId?: number | null;
  shiftId?: number | null;
  orderId: number;
  printerId: number;
  jobType: "order_ticket" | "receipt" | "label" | "thank_you_sticker";
  payloadJson: object;
  renderedText: string;
  operatorUserId?: number;
  renderFormat?: "text" | "png";
  artworkChecksum?: string | null;
}): Promise<PrintJob> {
  const key = makeIdempotencyKey(opts.orderId, opts.printerId, opts.jobType);
  const existing = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.idempotencyKey, key)).limit(1);
  if (existing.length) return existing[0];

  const [job] = await db.insert(printJobsTable).values({
    tenantId: opts.tenantId,
    locationId: opts.locationId ?? null,
    shiftId: opts.shiftId ?? null,
    orderId: opts.orderId,
    printerId: opts.printerId,
    jobType: opts.jobType,
    status: "queued",
    idempotencyKey: key,
    renderFormat: opts.renderFormat ?? "text",
    payloadJson: opts.payloadJson,
    renderedText: opts.renderedText,
    artworkChecksum: opts.artworkChecksum ?? null,
    operatorUserId: opts.operatorUserId ?? null,
  }).returning();
  return job;
}

// ── Raw Ethernet Dispatch ──────────────────────────────────────────────────────

async function dispatchEthernet(
  job: PrintJob,
  printer: PrintPrinter
): Promise<{ success: boolean; error?: string }> {
  if (!printer.directIp) return { success: false, error: "No directIp configured" };

  const port = printer.directPort ?? 9100;
  const timeoutMs = printer.timeoutMs ?? 5000;
  const text = decodeStoredReceiptText(job.renderedText ?? "");
  const fullText = text.repeat(Math.max(1, Math.min(printer.copies ?? 1, 5)));

  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ success: ok, error });
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, printer.directIp!, () => {
      socket.write(fullText, "binary", err => {
        if (err) return finish(false, err.message);
        setTimeout(() => finish(true), 200);
      });
    });
    socket.on("timeout", () => finish(false, `TCP timeout after ${timeoutMs}ms`));
    socket.on("error", e => finish(false, e.message));
  });
}

// ── HTTP Bridge Dispatch ───────────────────────────────────────────────────────

/**
 * The credential for a printer's bridge: a legacy per-printer key, else the
 * key on the printer's own tenant bridge profile, else the central key. This
 * lets each bridge (Mac, Pi, ...) hold its own secret.
 */
async function resolvePrinterBridgeKey(printer: PrintPrinter): Promise<string> {
  if (printer.apiKey) return printer.apiKey;
  let profileKey = "";
  if (printer.bridgeProfileId) {
    const [profile] = await db
      .select({ apiKey: printBridgeProfilesTable.apiKey })
      .from(printBridgeProfilesTable)
      .where(and(
        eq(printBridgeProfilesTable.tenantId, printer.tenantId),
        eq(printBridgeProfilesTable.id, printer.bridgeProfileId),
      ))
      .limit(1);
    profileKey = profile?.apiKey ?? "";
  }
  return profileKey || process.env.PRINT_BRIDGE_API_KEY || "";
}

async function dispatchBridge(
  job: PrintJob,
  printer: PrintPrinter
): Promise<{ success: boolean; error?: string; responsePayload?: object }> {
  const apiKey = await resolvePrinterBridgeKey(printer);
  const timeoutMs = printer.timeoutMs ?? 8000;
  const text = decodeStoredReceiptText(job.renderedText ?? "");
  const fullText = text.repeat(Math.max(1, Math.min(printer.copies ?? 1, 5)));

  if (!printer.bridgeUrl) {
    return { success: false, error: "Bridge URL not configured — set it in Admin → Print → Printers" };
  }
  if (!apiKey) {
    return { success: false, error: "API key missing — add it to this printer's settings in Admin → Print → Printers" };
  }

  // Resolve printer name before the try block so it's accessible in catch
  const printerName = printer.bridgePrinterName ?? printer.name;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(printerName)) {
    return {
      success: false,
      error: `Invalid or empty bridge queue name "${printerName}"; refusing system-default CUPS fallback`,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Sanitize the payload for PNG jobs — don't log full base64
    const payloadForLog = job.renderFormat === "png"
      ? { ...((job.payloadJson as object) ?? {}), imageData: "[base64 omitted]" }
      : job.renderFormat === "pdf"
        ? { ...((job.payloadJson as object) ?? {}), pdfBase64: "[base64 omitted]" }
        : job.payloadJson;

    pLog.info({
      event: "bridge_dispatch",
      jobId: job.id,
      jobType: job.jobType,
      renderFormat: job.renderFormat,
      printerId: printer.id,
      printerName,
      bridgeUrl: printer.bridgeUrl,
      hasApiKey: Boolean(apiKey),
      timeoutMs,
      payloadKeys: Object.keys((payloadForLog as object) ?? {}),
    }, "dispatching to bridge");

    // For PNG jobs, pull the base64 image out of payloadJson.imageData and send
    // it as imageBase64 so the bridge can write it to a temp file and lp-print it.
    const imageBase64 = job.renderFormat === "png"
      ? ((job.payloadJson as Record<string, unknown>)?.imageData as string | undefined)
      : undefined;

    // Full-page documents are server-rendered PDFs; the bridge prints the
    // bytes to the registered queue (never a raw/ESC-POS job).
    const documentBase64 = job.renderFormat === "pdf"
      ? ((job.payloadJson as Record<string, unknown>)?.pdfBase64 as string | undefined)
      : undefined;
    if (job.renderFormat === "pdf" && !documentBase64) {
      return { success: false, error: "PDF print job has no document" };
    }

    const bridgeBody: Record<string, unknown> = {
      printerName,
      jobId: job.id,
      format: job.renderFormat,
      text: documentBase64 ? "" : fullText,
      copies: 1,
      role: job.jobType,
    };
    if (documentBase64) {
      bridgeBody.documentBase64 = documentBase64;
      bridgeBody.raw = false;
      bridgeBody.copies = Math.max(1, Math.min(printer.copies ?? 1, 5));
    }
    if (imageBase64) {
      bridgeBody.imageBase64 = imageBase64;
      const requestedMedia = (job.payloadJson as Record<string, unknown>)?.media;
      if (typeof requestedMedia === "string" && requestedMedia.trim()) bridgeBody.media = requestedMedia;
      bridgeBody.raw = false;
    }

    const res = await fetch(`${printer.bridgeUrl}/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(bridgeBody),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    // ── Classify HTTP errors explicitly ────────────────────────────────────
    if (res.status === 401 || res.status === 403) {
      return { success: false, error: "API key invalid or rejected — update the API Key in printer settings" };
    }
    if (res.status === 404) {
      let body: { error?: string } = {};
      try { body = await res.json() as { error?: string }; } catch { /* ignore */ }
      return { success: false, error: `Printer "${printerName}" not found on bridge — check the Printer Name on Bridge setting. Bridge says: ${body.error ?? "not found"}` };
    }
    if (!res.ok) {
      let body: { error?: string } = {};
      try { body = await res.json() as { error?: string }; } catch { /* ignore */ }
      return { success: false, error: `Bridge returned HTTP ${res.status}: ${body.error ?? res.statusText}` };
    }

    const responsePayload = await res.json() as { success?: boolean; error?: string };
    if (responsePayload.success) {
      pLog.info({ event: "bridge_success", jobId: job.id, printerName, httpStatus: res.status }, "bridge print succeeded");
      return { success: true, responsePayload };
    }
    const failMsg = responsePayload.error ?? "Bridge returned failure without details";
    pLog.warn({ event: "bridge_failure", jobId: job.id, printerName, httpStatus: res.status, bridgeError: failMsg }, "bridge print failed");
    return { success: false, error: failMsg, responsePayload };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const msg = `Bridge timed out after ${timeoutMs}ms — is it reachable on Tailscale? Check ${printer.bridgeUrl}`;
      pLog.warn({ event: "bridge_timeout", jobId: job.id, printerName, bridgeUrl: printer.bridgeUrl, timeoutMs }, msg);
      return { success: false, error: msg };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch failed") || msg.includes("UND_ERR")) {
      const friendlyMsg = `Bridge unreachable at ${printer.bridgeUrl} — verify Tailscale is connected and the bridge service is running`;
      pLog.warn({ event: "bridge_unreachable", jobId: job.id, printerName, bridgeUrl: printer.bridgeUrl, rawError: msg }, friendlyMsg);
      return { success: false, error: friendlyMsg };
    }
    pLog.error({ event: "bridge_error", jobId: job.id, printerName, rawError: msg }, "unexpected bridge error");
    return { success: false, error: msg };
  }
}

// ── Attempt Recording ─────────────────────────────────────────────────────────

async function recordAttempt(opts: {
  tenantId: number;
  jobId: number;
  attemptNumber: number;
  routeUsed: string;
  success: boolean;
  errorMessage?: string | null;
  requestPayload: object;
  responsePayload?: object | null;
  durationMs?: number;
}) {
  await db.insert(printJobAttemptsTable).values({
    tenantId: opts.tenantId,
    printJobId: opts.jobId,
    attemptNumber: opts.attemptNumber,
    routeUsed: opts.routeUsed,
    success: opts.success,
    errorMessage: opts.errorMessage ?? null,
    requestPayload: opts.requestPayload,
    responsePayload: opts.responsePayload ?? null,
    durationMs: opts.durationMs ?? null,
  });
}

function printerMatchesJobScope(job: PrintJob, printer: PrintPrinter): boolean {
  return printer.isActive && job.tenantId === printer.tenantId && (job.locationId === null
    ? printer.routingScope === "general" && printer.locationId === null
    : printer.routingScope === "location" && printer.locationId === job.locationId);
}

async function failClosedScopeMismatch(job: PrintJob, printer: PrintPrinter): Promise<boolean> {
  if (printerMatchesJobScope(job, printer)) return false;
  await db.update(printJobsTable).set({ status: "failed", errorMessage: "Printer is inactive or outside the job tenant/location scope" }).where(and(eq(printJobsTable.tenantId, job.tenantId), eq(printJobsTable.id, job.id)));
  return true;
}

// ── Full Dispatch with Failover ────────────────────────────────────────────────

/**
 * Atomically moves a queued/retrying job to "sending". A request's inline
 * dispatch and the retry worker can both hold the same new job; only the one
 * that wins the claim sends it, so a job reaches the printer at most once.
 */
async function claimJob(job: PrintJob): Promise<boolean> {
  const claimed = await db.update(printJobsTable)
    .set({ status: "sending", lastAttemptAt: new Date() })
    .where(and(
      eq(printJobsTable.tenantId, job.tenantId),
      eq(printJobsTable.id, job.id),
      inArray(printJobsTable.status, ["queued", "retrying"]),
    ))
    .returning({ id: printJobsTable.id });
  if (claimed.length > 0) return true;
  pLog.info({ event: "dispatch_skipped_already_claimed", jobId: job.id }, "job already claimed by another dispatcher");
  return false;
}

/**
 * Dispatch a receipt job: ethernet_direct → pi_bridge → mark retrying.
 */
export async function dispatchReceiptJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  if (await failClosedScopeMismatch(job, printer)) return;
  if (!(await claimJob(job))) return;

  const attemptBase = (job.retryCount ?? 0) + 1;
  const maxRetries = job.jobType === "thank_you_sticker" ? 1 : (job.maxRetries ?? 5);

  // ── Try primary printer (ethernet_direct or bridge) ──────────────────────
  const t0 = Date.now();
  let result: { success: boolean; error?: string; responsePayload?: object };

  if (printer.connectionType === "ethernet_direct") {
    result = await dispatchEthernet(job, printer);
  } else {
    result = await dispatchBridge(job, printer);
  }

  await recordAttempt({
    tenantId: job.tenantId,
    jobId: job.id,
    attemptNumber: attemptBase,
    routeUsed: printer.connectionType,
    success: result.success,
    errorMessage: result.error,
    requestPayload: { printerId: printer.id, route: printer.connectionType },
    responsePayload: result.responsePayload ?? null,
    durationMs: Date.now() - t0,
  });

  if (result.success) {
    await db.update(printJobsTable).set({
      status: "printed",
      printedAt: new Date(),
      retryCount: attemptBase,
      printedVia: printer.connectionType,
    }).where(eq(printJobsTable.id, job.id));
    return;
  }

  // ── Failed — queue for retry ───────────────────────────────────────────────
  // Bridge selection and fallback ordering is handled upstream by
  // resolveReceiptPrinters / resolveRoutingDecision before the job is created.
  const nextStatus = attemptBase >= maxRetries ? "failed" : "retrying";
  await db.update(printJobsTable).set({
    status: nextStatus,
    retryCount: attemptBase,
    errorMessage: result.error ?? "Receipt print failed — bridge unreachable or rejected job",
  }).where(eq(printJobsTable.id, job.id));
}

/**
 * Dispatch a label job via the resolved bridge printer → queue on failure.
 */
export async function dispatchLabelJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  if (await failClosedScopeMismatch(job, printer)) return;
  if (!(await claimJob(job))) return;

  const attemptNumber = (job.retryCount ?? 0) + 1;
  const maxRetries = job.jobType === "thank_you_sticker" ? 1 : (job.maxRetries ?? 5);

  const t0 = Date.now();
  const result = await dispatchBridge(job, printer);

  await recordAttempt({
    tenantId: job.tenantId,
    jobId: job.id,
    attemptNumber,
    routeUsed: printer.connectionType,
    success: result.success,
    errorMessage: result.error,
    requestPayload: { printerId: printer.id, route: printer.connectionType },
    responsePayload: result.responsePayload ?? null,
    durationMs: Date.now() - t0,
  });

  if (result.success) {
    await db.update(printJobsTable).set({
      status: "printed",
      printedAt: new Date(),
      retryCount: attemptNumber,
      printedVia: printer.connectionType,
    }).where(eq(printJobsTable.id, job.id));
    return;
  }

  // Failed — queue for retry or mark failed.
  const nextStatus = attemptNumber >= maxRetries ? "failed" : "retrying";
  await db.update(printJobsTable).set({
    status: nextStatus,
    retryCount: attemptNumber,
    errorMessage: result.error ?? "Label print failed — bridge unreachable or rejected job",
  }).where(eq(printJobsTable.id, job.id));

}

/** Generic dispatch — routes by jobType then connectionType. */
export async function dispatchJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  // Thank You stickers are claimed only by the outbound staging pull bridge.
  // The API must never push them to an inbound bridge or a local/default queue.
  if (job.jobType === "thank_you_sticker") return;
  if (await failClosedScopeMismatch(job, printer)) return;
  if (job.jobType === "label") {
    return dispatchLabelJob(job, printer);
  }
  return dispatchReceiptJob(job, printer);
}

// ── Order Print Enqueue ───────────────────────────────────────────────────────

/**
 * Automatic receipt text through the shared receipt pipeline (the same one
 * reprint and preview use). Falls back to the legacy render only when the
 * committed order cannot be loaded, so printing never fails silently.
 */
async function renderAutomaticReceipt(
  tenantId: number,
  orderId: number,
  legacyOrder: Parameters<typeof renderCustomerReceipt>[0],
  columns: number,
): Promise<{ text: string; templateId: number | null; templateVersion: number | null }> {
  try {
    const { renderOrderReceipt } = await import("./print/receiptPipeline");
    const rendered = await renderOrderReceipt(tenantId, orderId, columns);
    if (rendered) {
      const { text, templateId, templateVersion } = rendered.receipt;
      return { text, templateId, templateVersion };
    }
    pLog.warn({ event: "receipt_data_unavailable", orderId }, "receipt data not found; using legacy receipt");
  } catch (err) {
    pLog.warn({ event: "receipt_pipeline_error", orderId, err: err instanceof Error ? err.message : String(err) },
      "receipt pipeline failed; using legacy receipt");
  }
  const paperWidth = columns <= 32 ? "58mm" : "80mm";
  return { text: renderCustomerReceipt({ ...legacyOrder, paperWidth }), templateId: null, templateVersion: null };
}

export async function enqueueOrderPrintJobs(order: {
  id: number;
  status: string;
  paymentStatus: string;
  notes: string | null;
  subtotal: string;
  tax: string;
  total: string;
  createdAt: Date;
  items: {
    quantity: number;
    catalogItemName: string;
    unitPrice: string;
    totalPrice: string;
    notes?: string | null;
    alavontName?: string | null;
    luciferCruzName?: string | null;
  }[];
  customerName?: string;
  customerFirstName?: string | null;
  fulfillmentType?: string;
  tenantId?: number | null;
  shippingAddress?: string | null;
  assignedShiftId?: number | null;
}) {
  if (!order.tenantId) {
    pLog.error({ event: "printing_blocked_missing_tenant", orderId: order.id }, "printing failed closed: order has no tenant ownership");
    return;
  }
  const tenantId = order.tenantId;
  // Automatic printing is switched per tenant; no row means everything off.
  const controls = await getPrintControls(tenantId);
  if (!controls.autoPrintOrders && !controls.autoPrintReceipts && !controls.autoPrintLabels) return;
  const settings = await getSettings();

  // Load receiptLineNameMode from admin settings (dual-brand receipt control)
  let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" = "lucifer_only";
  try {
    const [adminSettings] = await db.select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
      .from(adminSettingsTable)
      .where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
    if (adminSettings?.receiptLineNameMode) {
      receiptLineNameMode = adminSettings.receiptLineNameMode as typeof receiptLineNameMode;
    }
  } catch { /* non-critical — use default */ }

  // Resolve operator
  const operator = await selectActiveOperator(tenantId);
  const profile = operator?.profile ?? null;
  const [orderAssignment] = order.assignedShiftId ? await db.select().from(shiftPrintAssignmentsTable).where(and(eq(shiftPrintAssignmentsTable.tenantId, tenantId), eq(shiftPrintAssignmentsTable.shiftId, order.assignedShiftId))).limit(1) : [];
  const operatorName = operator
    ? (`${operator.firstName ?? ""} ${operator.lastName ?? ""}`).trim() || operator.email || undefined
    : undefined;
  const receiptWidth = charWidth(settings.paperWidth ?? "80mm");
  const receiptLogoLines = settings.includeLogo !== false ? getLogo(receiptWidth) : [];
  const brandingDisplayName = (await getBranding(tenantId))?.supplier.displayName;

  const printOrder = {
    id: order.id,
    customerName: order.customerName,
    fulfillmentType: order.fulfillmentType,
    notes: order.notes ?? undefined,
    receiptLineNameMode,
    receiptBrandName: typeof brandingDisplayName === "string" && brandingDisplayName.toLowerCase().includes("lucifer") ? "LUCIFER CRUZ" : "MYORDER.FUN",
    paperWidth: settings.paperWidth ?? "80mm",
    logoLines: receiptLogoLines,
    dualBrandName: settings.brandName ?? undefined,
    footerMessage: settings.footerMessage ?? undefined,
    showDiscreetNotice: settings.showDiscreetNotice ?? false,
    showOperatorName: settings.includeOperatorName !== false,
    operatorName,
    receiptTemplateStyle: (settings.receiptTemplateStyle as "clean" | "classic" | "compact" | null) ?? "clean",
    items: order.items.map(i => ({
      quantity: i.quantity,
      name: i.catalogItemName,
      alavontName: i.alavontName ?? i.catalogItemName,
      luciferCruzName: i.luciferCruzName ?? i.catalogItemName,
      notes: i.notes ?? undefined,
      unitPrice: parseFloat(i.unitPrice as string),
      totalPrice: parseFloat(i.totalPrice as string),
    })),
    subtotal: parseFloat(order.subtotal as string),
    tax: parseFloat(order.tax as string),
    total: parseFloat(order.total as string),
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
  };

  const orderContext = {
    id: order.id,
    tenantId: order.tenantId ?? null,
    fulfillmentType: order.fulfillmentType ?? null,
    shippingAddress: order.shippingAddress ?? null,
  };

  // ── Receipt, expo and work tickets ────────────────────────────────────────
  // Each is routed by document type to exactly one registered printer. The
  // legacy resolvers keep today's destinations when no route is configured.
  const routeContext = { tenantId, locationId: orderAssignment?.locationId ?? null, shiftId: order.assignedShiftId ?? null };
  const { queueDocumentPrint } = await import("./print/documentJobs");
  const { shiftLocationId } = await import("./print/shiftDocuments");
  const documentBase = {
    tenantId,
    locationId: routeContext.locationId ?? (routeContext.shiftId ? await shiftLocationId(tenantId, routeContext.shiftId) : null),
    shiftId: routeContext.shiftId,
    orderId: order.id,
    operatorUserId: operator?.userId ?? null,
    metadata: { orderId: order.id },
  };

  if (controls.autoPrintReceipts || controls.autoPrintOrders) {
    const result = await queueDocumentPrint({
      ...documentBase,
      documentType: "ORDER_RECEIPT",
      jobType: "customer_receipt",
      idempotencyKey: `order_receipt:${tenantId}:${order.id}`,
      render: { kind: "thermal-text", text: (_printer, columns) => renderAutomaticReceipt(tenantId, order.id, printOrder, columns) },
      legacyFallback: async () => (await resolveReceiptPrinters(profile, routeContext)).primary,
    });
    if (result.status === "queued") dispatchReceiptJob(result.job, result.printer).catch(() => {});
    else if (result.status === "no-route") pLog.warn({ event: "receipt_no_route", orderId: order.id, reason: result.reason }, "receipt not printed: no route");
  }

  if (controls.autoPrintOrders) {
    const { loadReceiptData } = await import("./print/receiptPipeline");
    const { buildExpoTicket, buildWorkTicket } = await import("./print/documents");
    const ticketData = await loadReceiptData(tenantId, order.id);
    const expoFallback = routeContext.locationId && routeContext.shiftId
      ? () => resolveExpoPrinter({ tenantId, locationId: routeContext.locationId!, shiftId: routeContext.shiftId! })
      : undefined;
    const tickets = [
      { documentType: "EXPO" as const, jobType: "expo_ticket", build: buildExpoTicket, legacyFallback: expoFallback },
      { documentType: "WORK" as const, jobType: "order_ticket", build: buildWorkTicket, legacyFallback: undefined },
    ];
    for (const ticket of ticketData ? tickets : []) {
      const result = await queueDocumentPrint({
        ...documentBase,
        documentType: ticket.documentType,
        jobType: ticket.jobType,
        idempotencyKey: `${ticket.jobType}:${tenantId}:${order.id}`,
        render: { kind: "thermal", lines: () => ticket.build(ticketData!) },
        legacyFallback: ticket.legacyFallback,
        recordNoRoute: false,
      });
      if (result.status === "queued") dispatchJob(result.job, result.printer).catch(() => {});
    }
  }

  // ── Label ─────────────────────────────────────────────────────────────────
  if (controls.autoPrintLabels) {
    const { resolveRoutingDecision, shouldPrintLabel } = await import("./printRoutingResolver.js");

    // Label eligibility gate — only delivery orders or Lucifer Cruz shipments
    const eligibility = shouldPrintLabel(orderContext);
    if (!eligibility.eligible) {
      pLog.info({ event: "label_skipped_not_eligible", orderId: order.id, reason: eligibility.reason }, "label skipped");
    } else {
      // Try smart routing resolver first (uses bridge profiles when configured)
      const routingDecision = await resolveRoutingDecision("label", orderContext);

      // Determine which printer to use
      let labelPrinter = routingDecision.selectedPrinter;

      // If routing resolver found no bridge profiles, fall back to legacy resolution
      if (!labelPrinter && routingDecision.selectedBridgeProfileId === null && !routingDecision.blockedReason) {
        labelPrinter = await resolveLabelPrinter(profile, tenantId);
      }

      if (!labelPrinter && routingDecision.blockedReason) {
        // Routing explicitly blocked label (e.g. operator not on Mac network, no Pi label bridge)
        pLog.warn({ event: "label_blocked", orderId: order.id, reason: routingDecision.blockedReason }, "label blocked by routing policy");
      } else if (labelPrinter) {
        const customerName = order.customerName ?? "";
        const { resolveLabelFirstName } = await import("./print/templates/thankYouLabel.js");
        const customerFirstName = resolveLabelFirstName({
          canonicalFirstName: order.customerFirstName,
          validatedFullName: customerName,
        });
        const labelData = {
          id: order.id,
          customerName,
          customerFirstName,
          total: `$${printOrder.total.toFixed(2)}`,
          createdAt: new Date(order.createdAt).toLocaleTimeString(),
        };
        const png = await generateThankYouLabel(customerFirstName);
        const imageData = png.toString("base64");
        const renderedText = `Thank you label for ${customerFirstName} — Order #${order.id}`;
        const key = makeIdempotencyKey(order.id, labelPrinter.id, "label");
        const existing = await db.select().from(printJobsTable)
          .where(eq(printJobsTable.idempotencyKey, key)).limit(1);

        if (!existing.length) {
          const [job] = await db.insert(printJobsTable).values({
            tenantId, locationId: routeContext.locationId, shiftId: routeContext.shiftId,
            orderId: order.id,
            printerId: labelPrinter.id,
            jobType: "label",
            status: "queued",
            idempotencyKey: key,
            renderFormat: "png",
            payloadJson: {
              ...labelData,
              imageData,
              template: "thank_you_personalized",
              _routingDecision: { decisionReason: routingDecision.decisionReason, fallbackUsed: routingDecision.fallbackUsed },
            },
            renderedText,
            operatorUserId: operator?.userId ?? null,
          }).returning();
          dispatchLabelJob(job, labelPrinter).catch(() => {});
        }
      } else {
        pLog.warn({ event: "label_no_printer", orderId: order.id, decision: routingDecision.decisionReason }, "label skipped: no printer available");
      }
    }
  }
}

// ── Retry Worker ──────────────────────────────────────────────────────────────

/** Longer than any bridge timeout, so a live dispatch is never interrupted. */
export const STALE_SENDING_MS = 5 * 60_000;
export const STALE_SENDING_ERROR = "Interrupted while sending; it may have printed. Not retried automatically — reprint if it did not print.";

/**
 * A job left in "sending" (the API restarted mid-dispatch) may already have
 * reached the printer, so resending it could print twice. It is failed for an
 * operator to reprint instead of retried, keeping dispatch at-most-once.
 */
export async function failStaleSendingJobs(now = new Date()): Promise<number> {
  const stale = await db.update(printJobsTable)
    .set({ status: "failed", errorMessage: STALE_SENDING_ERROR })
    .where(and(
      eq(printJobsTable.status, "sending"),
      lt(printJobsTable.lastAttemptAt, new Date(now.getTime() - STALE_SENDING_MS)),
    ))
    .returning({ id: printJobsTable.id });
  if (stale.length > 0) pLog.warn({ event: "stale_sending_failed", jobIds: stale.map((job) => job.id) }, "failed jobs interrupted while sending");
  return stale.length;
}

let workerRunning = false;

export function startPrintWorker() {
  if (workerRunning) return;
  workerRunning = true;

  async function tick() {
    try {
      await failStaleSendingJobs();
      const retrying = await db.select().from(printJobsTable)
        .where(and(inArray(printJobsTable.status, ["queued", "retrying"]), sql`${printJobsTable.jobType} <> 'thank_you_sticker'`))
        .limit(10);

      for (const job of retrying) {
        if (!job.printerId) continue;
        const [printer] = await db.select().from(printPrintersTable)
          .where(and(eq(printPrintersTable.tenantId, job.tenantId), eq(printPrintersTable.id, job.printerId))).limit(1);
        if (printer) {
          await dispatchJob(job, printer).catch(() => {});
        }
      }
    } catch { /* intentionally empty */ }

    setTimeout(tick, 15_000);
  }

  setTimeout(tick, 5_000);
}
