/**
 * printService.ts — Production print dispatch with operator selection,
 * ethernet direct, and HTTP bridge support, queue + retry.
 *
 * Receipt flow:  ethernet_direct → bridge (resolved by printRouter) → queue
 * Label flow:    bridge (resolved by printRoutingResolver) → queue + SMS alert
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
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
  adminSettingsTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { renderKitchenTicket, renderCustomerReceipt } from "./receiptRenderer";
import { renderTextLabel } from "./labelRenderer";
import {
  selectActiveOperator,
  resolveReceiptPrinters,
  resolveLabelPrinter,
  probeEthernet,
  probeBridge,
} from "./printRouter";
import type { PrintJob, PrintPrinter } from "@workspace/db";
import { logger as _logger } from "./logger";

const pLog = _logger.child({ module: "printService" });

// ── Idempotency ───────────────────────────────────────────────────────────────

export function makeIdempotencyKey(orderId: number, printerId: number, jobType: string): string {
  return crypto
    .createHash("sha256")
    .update(`${orderId}:${printerId}:${jobType}`)
    .digest("hex");
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings() {
  const rows = await db.select().from(printSettingsTable).limit(1);
  if (rows.length) return rows[0];
  const [created] = await db.insert(printSettingsTable).values({}).returning();
  return created;
}

// ── Job Creation ──────────────────────────────────────────────────────────────

export async function createPrintJob(opts: {
  orderId: number;
  printerId: number;
  jobType: "order_ticket" | "receipt" | "label";
  payloadJson: object;
  renderedText: string;
  operatorUserId?: number;
  renderFormat?: "text" | "png";
}): Promise<PrintJob> {
  const key = makeIdempotencyKey(opts.orderId, opts.printerId, opts.jobType);
  const existing = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.idempotencyKey, key)).limit(1);
  if (existing.length) return existing[0];

  const [job] = await db.insert(printJobsTable).values({
    orderId: opts.orderId,
    printerId: opts.printerId,
    jobType: opts.jobType,
    status: "queued",
    idempotencyKey: key,
    renderFormat: opts.renderFormat ?? "text",
    payloadJson: opts.payloadJson,
    renderedText: opts.renderedText,
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
  const text = job.renderedText ?? "";
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

async function dispatchBridge(
  job: PrintJob,
  printer: PrintPrinter
): Promise<{ success: boolean; error?: string; responsePayload?: object }> {
  const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
  const timeoutMs = printer.timeoutMs ?? 8000;
  const text = job.renderedText ?? "";
  const fullText = text.repeat(Math.max(1, Math.min(printer.copies ?? 1, 5)));

  if (!printer.bridgeUrl) {
    return { success: false, error: "Bridge URL not configured — set it in Admin → Print → Printers" };
  }
  if (!apiKey) {
    return { success: false, error: "API key missing — add it to this printer's settings in Admin → Print → Printers" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const printerName = printer.bridgePrinterName ?? printer.name;

    // Sanitize the payload for PNG jobs — don't log full base64
    const payloadForLog = job.renderFormat === "png"
      ? { ...((job.payloadJson as object) ?? {}), imageData: "[base64 omitted]" }
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
      payloadKeys: Object.keys((job.payloadJson as object) ?? {}),
    }, "dispatching to bridge");

    // For PNG jobs, pull the base64 image out of payloadJson.imageData and send
    // it as imageBase64 so the bridge can write it to a temp file and lp-print it.
    const imageBase64 = job.renderFormat === "png"
      ? ((job.payloadJson as Record<string, unknown>)?.imageData as string | undefined)
      : undefined;

    const bridgeBody: Record<string, unknown> = {
      printerName,
      jobId: job.id,
      format: job.renderFormat,
      text: fullText,
      copies: 1,
    };
    if (imageBase64) bridgeBody.imageBase64 = imageBase64;

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
      try { body = await res.json(); } catch { /* ignore */ }
      return { success: false, error: `Printer "${printerName}" not found on bridge — check the Printer Name on Bridge setting. Bridge says: ${body.error ?? "not found"}` };
    }
    if (!res.ok) {
      let body: { error?: string } = {};
      try { body = await res.json(); } catch { /* ignore */ }
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

// ── Full Dispatch with Failover ────────────────────────────────────────────────

/**
 * Dispatch a receipt job: ethernet_direct → pi_bridge → mark retrying.
 */
export async function dispatchReceiptJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  await db.update(printJobsTable)
    .set({ status: "sending", lastAttemptAt: new Date() })
    .where(eq(printJobsTable.id, job.id));

  const attemptBase = (job.retryCount ?? 0) + 1;
  const maxRetries = job.maxRetries ?? 5;

  // ── Try primary printer (ethernet_direct or bridge) ──────────────────────
  const t0 = Date.now();
  let result: { success: boolean; error?: string; responsePayload?: object };

  if (printer.connectionType === "ethernet_direct") {
    result = await dispatchEthernet(job, printer);
  } else {
    result = await dispatchBridge(job, printer);
  }

  await recordAttempt({
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
 * Dispatch a label job via the resolved bridge printer → queue + SMS alert on failure.
 */
export async function dispatchLabelJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  await db.update(printJobsTable)
    .set({ status: "sending", lastAttemptAt: new Date() })
    .where(eq(printJobsTable.id, job.id));

  const attemptNumber = (job.retryCount ?? 0) + 1;
  const maxRetries = job.maxRetries ?? 5;

  const t0 = Date.now();
  const result = await dispatchBridge(job, printer);

  await recordAttempt({
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

  // Failed — queue + optionally alert
  const nextStatus = attemptNumber >= maxRetries ? "failed" : "retrying";
  await db.update(printJobsTable).set({
    status: nextStatus,
    retryCount: attemptNumber,
    errorMessage: result.error ?? "Label print failed — bridge unreachable or rejected job",
  }).where(eq(printJobsTable.id, job.id));

  // Alert admin via SMS if configured
  const settings = await getSettings();
  if (settings.alertOnLabelFailure && nextStatus === "failed") {
    await sendLabelFailureAlert(job.id, result.error ?? "unknown error").catch(() => {});
  }
}

/** Generic dispatch — routes by jobType then connectionType. */
export async function dispatchJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  if (job.jobType === "label") {
    return dispatchLabelJob(job, printer);
  }
  return dispatchReceiptJob(job, printer);
}

// ── Failure Alert ─────────────────────────────────────────────────────────────

async function sendLabelFailureAlert(jobId: number, error: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const adminPhone = process.env.ADMIN_ALERT_PHONE;

  if (!sid || !token || !from || !adminPhone) return;

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: adminPhone,
      Body: `[Alavont] Label print job #${jobId} failed: ${error.slice(0, 120)}. Check Admin → Print.`,
    }).toString(),
  });
}

// ── Order Print Enqueue ───────────────────────────────────────────────────────

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
  fulfillmentType?: string;
  tenantId?: number | null;
  shippingAddress?: string | null;
}) {
  const settings = await getSettings();
  if (!settings.autoPrintOrders) return;

  // Load receiptLineNameMode from admin settings (dual-brand receipt control)
  let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" = "lucifer_only";
  try {
    const [adminSettings] = await db.select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
      .from(adminSettingsTable)
      .limit(1);
    if (adminSettings?.receiptLineNameMode) {
      receiptLineNameMode = adminSettings.receiptLineNameMode as typeof receiptLineNameMode;
    }
  } catch { /* non-critical — use default */ }

  // Resolve operator
  const operator = await selectActiveOperator();
  const profile = operator?.profile ?? null;

  const printOrder = {
    id: order.id,
    customerName: order.customerName,
    fulfillmentType: order.fulfillmentType,
    notes: order.notes ?? undefined,
    receiptLineNameMode,
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

  // ── Receipt ───────────────────────────────────────────────────────────────
  const { primary: receiptPrinter, fallback: piFallback } = await resolveReceiptPrinters(profile);

  if (receiptPrinter) {
    const renderedText = renderCustomerReceipt(printOrder);
    const key = makeIdempotencyKey(order.id, receiptPrinter.id, "receipt");
    const existing = await db.select().from(printJobsTable)
      .where(eq(printJobsTable.idempotencyKey, key)).limit(1);

    let job = existing[0];
    if (!job) {
      [job] = await db.insert(printJobsTable).values({
        orderId: order.id,
        printerId: receiptPrinter.id,
        jobType: "receipt",
        status: "queued",
        idempotencyKey: key,
        renderFormat: "text",
        payloadJson: printOrder,
        renderedText,
        operatorUserId: operator?.userId ?? null,
      }).returning();
    }

    dispatchReceiptJob(job, receiptPrinter).catch(() => {});
  }

  // ── Kitchen ticket ────────────────────────────────────────────────────────
  // Falls back to any active kitchen/expo printer if no profile
  const kitchenPrinters = await db.select().from(printPrintersTable)
    .where(and(
      eq(printPrintersTable.isActive, true),
      eq(printPrintersTable.role, "kitchen"),
    )).limit(3);

  for (const kp of kitchenPrinters) {
    const renderedText = renderKitchenTicket(printOrder);
    const key = makeIdempotencyKey(order.id, kp.id, "order_ticket");
    const existing = await db.select().from(printJobsTable)
      .where(eq(printJobsTable.idempotencyKey, key)).limit(1);

    if (!existing.length) {
      const [job] = await db.insert(printJobsTable).values({
        orderId: order.id,
        printerId: kp.id,
        jobType: "order_ticket",
        status: "queued",
        idempotencyKey: key,
        renderFormat: "text",
        payloadJson: printOrder,
        renderedText,
        operatorUserId: operator?.userId ?? null,
      }).returning();
      dispatchJob(job, kp).catch(() => {});
    }
  }

  // ── Expo ticket ───────────────────────────────────────────────────────────
  // Expo printers get the same kitchen ticket as a bump-screen / pass station.
  const expoPrinters = await db.select().from(printPrintersTable)
    .where(and(
      eq(printPrintersTable.isActive, true),
      eq(printPrintersTable.role, "expo"),
    )).limit(3);

  for (const ep of expoPrinters) {
    const renderedText = renderKitchenTicket(printOrder);
    const key = makeIdempotencyKey(order.id, ep.id, "order_ticket");
    const existing = await db.select().from(printJobsTable)
      .where(eq(printJobsTable.idempotencyKey, key)).limit(1);

    if (!existing.length) {
      const [job] = await db.insert(printJobsTable).values({
        orderId: order.id,
        printerId: ep.id,
        jobType: "order_ticket",
        status: "queued",
        idempotencyKey: key,
        renderFormat: "text",
        payloadJson: printOrder,
        renderedText,
        operatorUserId: operator?.userId ?? null,
      }).returning();
      dispatchJob(job, ep).catch(() => {});
    }
  }

  // ── Label ─────────────────────────────────────────────────────────────────
  if (settings.autoPrintLabels) {
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
        labelPrinter = await resolveLabelPrinter(profile);
      }

      if (!labelPrinter && routingDecision.blockedReason) {
        // Routing explicitly blocked label (e.g. operator not on Mac network, no Pi label bridge)
        pLog.warn({ event: "label_blocked", orderId: order.id, reason: routingDecision.blockedReason }, "label blocked by routing policy");
      } else if (labelPrinter) {
        const labelTemplate = {
          name: "Order Label",
          paperWidth: labelPrinter.paperWidth ?? "58mm",
          fields: [
            { key: "id", label: "Order #", fontWeight: "bold" as const, fontSize: 20, align: "center" as const },
            { key: "customerName", label: "Customer", fontSize: 14 },
            { key: "total", label: "Total", fontSize: 14 },
            { key: "createdAt", label: "Time", fontSize: 12 },
          ],
        };
        const labelData = {
          id: order.id,
          customerName: order.customerName ?? "Walk-in",
          total: `$${printOrder.total.toFixed(2)}`,
          createdAt: new Date(order.createdAt).toLocaleTimeString(),
        };
        const renderedText = renderTextLabel(labelTemplate, labelData);
        const key = makeIdempotencyKey(order.id, labelPrinter.id, "label");
        const existing = await db.select().from(printJobsTable)
          .where(eq(printJobsTable.idempotencyKey, key)).limit(1);

        if (!existing.length) {
          const [job] = await db.insert(printJobsTable).values({
            orderId: order.id,
            printerId: labelPrinter.id,
            jobType: "label",
            status: "queued",
            idempotencyKey: key,
            renderFormat: "text",
            payloadJson: { ...labelData, _routingDecision: { decisionReason: routingDecision.decisionReason, fallbackUsed: routingDecision.fallbackUsed } },
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

let workerRunning = false;

export function startPrintWorker() {
  if (workerRunning) return;
  workerRunning = true;

  async function tick() {
    try {
      const retrying = await db.select().from(printJobsTable)
        .where(inArray(printJobsTable.status, ["queued", "retrying"]))
        .limit(10);

      for (const job of retrying) {
        if (!job.printerId) continue;
        const [printer] = await db.select().from(printPrintersTable)
          .where(eq(printPrintersTable.id, job.printerId)).limit(1);
        if (printer) {
          await dispatchJob(job, printer).catch(() => {});
        }
      }
    } catch (_) {}

    setTimeout(tick, 15_000);
  }

  setTimeout(tick, 5_000);
}
