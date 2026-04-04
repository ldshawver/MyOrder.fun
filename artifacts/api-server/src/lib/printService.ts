import crypto from "crypto";
import { db } from "@workspace/db";
import {
  printPrintersTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
} from "@workspace/db";
import { eq, and, lte, inArray } from "drizzle-orm";
import { renderKitchenTicket, renderCustomerReceipt } from "./receiptRenderer";
import type { PrintJob, PrintPrinter } from "@workspace/db";

export function makeIdempotencyKey(orderId: number, printerId: number, jobType: string): string {
  return crypto
    .createHash("sha256")
    .update(`${orderId}:${printerId}:${jobType}`)
    .digest("hex");
}

export async function getSettings() {
  const rows = await db.select().from(printSettingsTable).limit(1);
  if (rows.length) return rows[0];
  const [created] = await db.insert(printSettingsTable).values({}).returning();
  return created;
}

export async function createPrintJob(opts: {
  orderId: number;
  printerId: number;
  jobType: "order_ticket" | "receipt" | "label";
  payloadJson: object;
  renderedText: string;
}) {
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
    renderFormat: "text",
    payloadJson: opts.payloadJson,
    renderedText: opts.renderedText,
  }).returning();
  return job;
}

export async function dispatchJob(job: PrintJob, printer: PrintPrinter): Promise<void> {
  await db.update(printJobsTable)
    .set({ status: "sending", lastAttemptAt: new Date() })
    .where(eq(printJobsTable.id, job.id));

  let success = false;
  let errorMessage: string | null = null;
  let responsePayload: object | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), printer.timeoutMs ?? 8000);

    const res = await fetch(`${printer.bridgeUrl}/print`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "",
      },
      body: JSON.stringify({
        printerName: printer.bridgePrinterName ?? printer.name,
        jobId: job.id,
        format: job.renderFormat,
        text: job.renderedText,
        payload: job.payloadJson,
        copies: printer.copies ?? 1,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    responsePayload = await res.json() as object;
    success = (responsePayload as { success?: boolean }).success === true;
    if (!success) {
      errorMessage = (responsePayload as { error?: string }).error ?? "Bridge returned failure";
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const newRetryCount = (job.retryCount ?? 0) + 1;
  const maxRetries = job.maxRetries ?? 5;

  await db.insert(printJobAttemptsTable).values({
    printJobId: job.id,
    attemptNumber: newRetryCount,
    requestPayload: { printer: printer.name, jobId: job.id },
    responsePayload: responsePayload ?? {},
    success,
    errorMessage,
  });

  if (success) {
    await db.update(printJobsTable)
      .set({ status: "printed", printedAt: new Date(), retryCount: newRetryCount })
      .where(eq(printJobsTable.id, job.id));
  } else {
    const nextStatus = newRetryCount >= maxRetries ? "failed" : "retrying";
    await db.update(printJobsTable)
      .set({ status: nextStatus, retryCount: newRetryCount, errorMessage })
      .where(eq(printJobsTable.id, job.id));
  }
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
  items: { quantity: number; catalogItemName: string; unitPrice: string; totalPrice: string; notes?: string | null }[];
  customerName?: string;
  fulfillmentType?: string;
}) {
  const settings = await getSettings();
  if (!settings.autoPrintOrders) return;

  const printers = await db.select().from(printPrintersTable)
    .where(and(
      eq(printPrintersTable.isActive, true),
      inArray(printPrintersTable.role, ["kitchen", "receipt", "expo"]),
    ));

  if (!printers.length) return;

  const printOrder = {
    id: order.id,
    customerName: order.customerName,
    fulfillmentType: order.fulfillmentType,
    notes: order.notes ?? undefined,
    items: order.items.map(i => ({
      quantity: i.quantity,
      name: i.catalogItemName,
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

  for (const printer of printers) {
    const jobType = printer.role === "receipt" ? "receipt" : "order_ticket";
    const renderedText = jobType === "receipt"
      ? renderCustomerReceipt(printOrder)
      : renderKitchenTicket(printOrder);

    const job = await createPrintJob({
      orderId: order.id,
      printerId: printer.id,
      jobType,
      payloadJson: printOrder,
      renderedText,
    });

    dispatchJob(job, printer).catch(() => {});
  }
}

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
          await dispatchJob(job, printer);
        }
      }
    } catch (_) {}

    setTimeout(tick, 15_000);
  }

  setTimeout(tick, 5_000);
}
