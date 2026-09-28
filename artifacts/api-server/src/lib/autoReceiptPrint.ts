/**
 * autoReceiptPrint.ts
 *
 * Fire-and-forget receipt printing triggered automatically after order creation.
 * Called from POST /api/orders when RECEIPT_PRINT_ENABLED=true and
 * the order tenant's print controls have autoPrintReceipts=true.
 *
 * Never throws — all errors are logged and silently dropped so order creation
 * is never blocked by a printer being offline.
 */
import { eq } from "drizzle-orm";
import { db, ordersTable, orderItemsTable } from "@workspace/db";
import { enqueueOrderPrintJobs } from "./printService";
import { getPrintControls } from "./printControls";
import { logger as _logger } from "./logger";

const log = _logger.child({ module: "autoReceiptPrint" });

export async function autoReceiptPrint(orderId: number): Promise<void> {
  // Guard: env flag must be explicitly true
  if (process.env.RECEIPT_PRINT_ENABLED !== "true") return;

  try {
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (!order?.tenantId) return;

    // Guard: the order's own tenant must have automatic receipts enabled.
    if (!(await getPrintControls(order.tenantId)).autoPrintReceipts) return;

    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));

    // The canonical tenant-scoped router is the only permitted automatic path.
    // Never invoke local/system-default CUPS from order completion.
    await enqueueOrderPrintJobs({
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes,
      subtotal: String(order.subtotal),
      tax: String(order.tax),
      total: String(order.total),
      createdAt: order.createdAt,
      tenantId: order.tenantId,
      fulfillmentType: order.orderType,
      shippingAddress: order.shippingAddress,
      assignedShiftId: order.assignedShiftId,
      items: items.map((item) => ({
        quantity: item.quantity,
        catalogItemName: item.catalogItemName,
        unitPrice: String(item.unitPrice),
        totalPrice: String(item.totalPrice),
        alavontName: item.alavontName,
        luciferCruzName: item.luciferCruzName,
      })),
    });
  } catch (err) {
    log.warn({ orderId, err }, "autoReceiptPrint: unexpected error (non-fatal)");
  }
}
