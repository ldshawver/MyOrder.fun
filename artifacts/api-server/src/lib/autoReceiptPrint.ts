/** Best-effort printing for an order whose completion committed. */
import { and, eq } from "drizzle-orm";
import { db, ordersTable, orderItemsTable, cashLedgerEntriesTable } from "@workspace/db";
import { enqueueOrderPrintJobs } from "./printService";
import { logger as _logger } from "./logger";

const log = _logger.child({ module: "autoReceiptPrint" });

export async function printCompletedOrderReceipt(tenantId: number, orderId: number): Promise<void> {

  try {
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId)))
      .limit(1);
    if (!order?.tenantId || order.status !== "completed" || order.paymentStatus !== "paid") return;

    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));

    // Cash accountability can belong to General Queue or to the closing shift.
    // Use the committed register even when the order has no assigned shift.
    const [cashRegister] = (order.selectedPaymentMethod ?? order.paymentMethod) === "cash"
      ? await db.select({
          box: cashLedgerEntriesTable.boxAssignmentId,
          locationId: cashLedgerEntriesTable.locationId,
          shiftId: cashLedgerEntriesTable.shiftId,
        }).from(cashLedgerEntriesTable).where(and(
          eq(cashLedgerEntriesTable.tenantId, tenantId),
          eq(cashLedgerEntriesTable.orderId, orderId),
          eq(cashLedgerEntriesTable.entryType, "cash_sale_closeout"),
        )).limit(1)
      : [];

    // The canonical tenant-scoped router is the only permitted automatic path.
    // Never invoke local/system-default CUPS from order completion.
    await enqueueOrderPrintJobs({
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      selectedPaymentMethod: order.selectedPaymentMethod,
      closeoutReceipt: true,
      notes: order.notes,
      subtotal: String(order.subtotal),
      tax: String(order.tax),
      total: String(order.total),
      createdAt: order.createdAt,
      tenantId: order.tenantId,
      fulfillmentType: order.deliveryMethod === "pickup" ? "pickup" : "delivery",
      shippingAddress: order.shippingAddress,
      assignedShiftId: order.assignedShiftId,
      cashRegister,
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
