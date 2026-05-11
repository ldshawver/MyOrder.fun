/**
 * autoReceiptPrint.ts
 *
 * Fire-and-forget receipt printing triggered automatically after order creation.
 * Called from POST /api/orders when RECEIPT_PRINT_ENABLED=true and
 * print settings autoPrintReceipts=true.
 *
 * Never throws — all errors are logged and silently dropped so order creation
 * is never blocked by a printer being offline.
 */
import { eq } from "drizzle-orm";
import { db, ordersTable, orderItemsTable, printJobsTable, adminSettingsTable } from "@workspace/db";
import {
  buildCustomerReceiptBlocks,
  renderBodyOnly,
  getLogo,
  charWidth,
} from "./print/index";
import { printReceiptEscPos } from "./escposPrinter";
import { getSettings } from "./printService";
import { logger as _logger } from "./logger";

const log = _logger.child({ module: "autoReceiptPrint" });

export async function autoReceiptPrint(orderId: number): Promise<void> {
  // Guard: env flag must be explicitly true
  if (process.env.RECEIPT_PRINT_ENABLED !== "true") return;

  try {
    // Guard: DB setting must also enable auto-print
    const settings = await getSettings();
    const s = settings as Record<string, unknown>;
    if (!s.autoPrintReceipts) return;

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (!order) return;

    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));

    const width = charWidth((s.paperWidth as string | undefined) ?? "80mm");
    const logoLines = s.includeLogo !== false ? getLogo(width) : [];

    let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" = "lucifer_only";
    try {
      const [adminRow] = await db
        .select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
        .from(adminSettingsTable)
        .limit(1);
      if (adminRow?.receiptLineNameMode) {
        receiptLineNameMode = adminRow.receiptLineNameMode as typeof receiptLineNameMode;
      }
    } catch { /* use default */ }

    const blocks = buildCustomerReceiptBlocks({
      orderId: order.id,
      orderNumber: String(order.id),
      createdAt: order.createdAt,
      fulfillmentType: "Pickup",
      paymentStatus: order.paymentStatus ?? undefined,
      paymentMethod: (order as Record<string, unknown>).paymentMethod as string | undefined,
      notes: order.notes ?? undefined,
      items: items.map((i) => ({
        name: i.receiptName ?? i.catalogItemName,
        quantity: i.quantity,
        unitPrice: parseFloat(String(i.unitPrice)),
        totalPrice: parseFloat(String(i.totalPrice)),
      })),
      subtotal: parseFloat(String(order.subtotal)),
      tax: order.tax ? parseFloat(String(order.tax)) : undefined,
      total: parseFloat(String(order.total)),
      logoLines,
      dualBrandName: (s.brandName as string | undefined) ?? undefined,
      footerMessage: (s.footerMessage as string | undefined) ?? undefined,
      showDiscreetNotice: Boolean(s.showDiscreetNotice),
      showOperatorName: s.includeOperatorName !== false,
    });

    const body = renderBodyOnly(blocks, width);
    const iKey = `auto:${orderId}:receipt:${Date.now()}`;

    const [job] = await db
      .insert(printJobsTable)
      .values({
        orderId: order.id,
        printerId: null,
        jobType: "receipt",
        status: "queued",
        idempotencyKey: iKey,
        renderFormat: "escpos",
        payloadJson: { orderId, source: "auto", receiptLineNameMode },
        renderedText: body,
        operatorUserId: null,
      })
      .returning();

    const printerEnabled = process.env.RECEIPT_PRINT_ENABLED === "true";
    if (!printerEnabled) {
      await db
        .update(printJobsTable)
        .set({ status: "failed", errorMessage: "RECEIPT_PRINT_ENABLED is not true" })
        .where(eq(printJobsTable.id, job.id));
      return;
    }

    try {
      await printReceiptEscPos(body);
      await db
        .update(printJobsTable)
        .set({ status: "printed", printedVia: "lp_cups", printedAt: new Date() })
        .where(eq(printJobsTable.id, job.id));
      log.info({ orderId, jobId: job.id }, "Auto-receipt printed");
    } catch (printErr) {
      const msg = (printErr as Error).message;
      await db
        .update(printJobsTable)
        .set({ status: "failed", errorMessage: msg })
        .where(eq(printJobsTable.id, job.id));
      log.warn({ orderId, jobId: job.id, err: msg }, "Auto-receipt print failed (order saved)");
    }
  } catch (err) {
    log.warn({ orderId, err }, "autoReceiptPrint: unexpected error (non-fatal)");
  }
}
