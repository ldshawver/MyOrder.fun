import { eq, sql } from "drizzle-orm";
import { db, inventoryReservationsTable, labTechShiftsTable, orderItemsTable, ordersTable } from "@workspace/db";
import { writeAuditLog } from "../lib/auth";
import { type InventoryOrderType } from "../lib/inventoryBalances";
import { executeTransaction, type InventoryKernelExecutor } from "../lib/inventoryKernel";
import { confirmInventoryReservationsForOrder, ensureInventoryReservationsTable, reserveCheckoutInventoryByOrderType } from "../lib/inventoryReservations";

export class PaymentInventoryError extends Error {
  constructor(public readonly catalogItemId: number) { super(`Insufficient inventory for catalog item ${catalogItemId}`); this.name = "PaymentInventoryError"; }
}

function orderTypeForPaidDeduction(order: typeof ordersTable.$inferSelect): InventoryOrderType {
  const raw = order.orderType;
  if (raw === "WALK_IN" || raw === "CSR" || raw === "ONLINE") return raw;
  return order.deliveryMethod === "csr_delivery" ? "CSR" : "ONLINE";
}

export async function deductPaidOrderInventory(
  order: typeof ordersTable.$inferSelect,
  auditContext?: { actorId: number; actorEmail: string | null | undefined; actorRole: string; ipAddress?: string },
  executor: InventoryKernelExecutor = db,
): Promise<void> {
  if (!order.assignedShiftId || order.routeSource !== "active_csr") return;
  await ensureInventoryReservationsTable();
  const [shift] = await executor.select({ boxAssignmentId: labTechShiftsTable.boxAssignmentId }).from(labTechShiftsTable).where(eq(labTechShiftsTable.id, order.assignedShiftId)).limit(1);
  if (!shift?.boxAssignmentId) return;
  const items = await executor.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const auditEntries: Array<{ productId: number; locationUsed: string | null; locationId: number; quantity: number; remainingStock: number; orderType: InventoryOrderType }> = [];
  await executeTransaction(executor, "payments.inventoryDeduct", async tx => {
    const existing = await tx.select({ status: inventoryReservationsTable.status, expiresAt: inventoryReservationsTable.expiresAt }).from(inventoryReservationsTable).where(eq(inventoryReservationsTable.orderId, order.id));
    const hasConfirmed = existing.some(row => row.status === "confirmed");
    const hasActiveReservation = existing.some(row => row.status === "reserved" && row.expiresAt > new Date());
    if (!hasConfirmed && !hasActiveReservation) {
      // A paid capture may arrive after the checkout hold expires. Preserve
      // the expired reservation row as history, but release its idempotency
      // key so the authoritative paid-sale recovery can reserve again.
      await tx.update(inventoryReservationsTable)
        .set({ status: "released", idempotencyKey: null, updatedAt: new Date() })
        .where(and(eq(inventoryReservationsTable.orderId, order.id), eq(inventoryReservationsTable.status, "reserved")));
      for (const item of items) {
        if (!item.catalogItemId) continue;
        const reservations = await reserveCheckoutInventoryByOrderType(tx, order.tenantId, order.id, item.catalogItemId, Number(item.quantity), orderTypeForPaidDeduction(order));
        if (!reservations) throw new PaymentInventoryError(item.catalogItemId);
        await tx.update(orderItemsTable).set({ inventoryDeductions: reservations }).where(eq(orderItemsTable.id, item.id));
      }
    }
    if (!auditContext) throw new Error("Inventory sale confirmation requires an audit actor");
    const confirmed = await confirmInventoryReservationsForOrder(tx, order.id, { id: auditContext.actorId, email: auditContext.actorEmail, role: auditContext.actorRole, ipAddress: auditContext.ipAddress });
    for (const item of items) {
      if (!item.catalogItemId) continue;
      const orderType = orderTypeForPaidDeduction(order);
      const details = confirmed.filter(row => row.productId === item.catalogItemId);
      if (details.length === 0) throw new PaymentInventoryError(item.catalogItemId);
      await tx.update(orderItemsTable).set({ inventoryDeductions: details.map(({ productId: _id, ...row }) => row) }).where(eq(orderItemsTable.id, item.id));
      for (const used of details) auditEntries.push({ productId: item.catalogItemId, locationUsed: used.locationName, locationId: used.locationId, quantity: used.quantity, remainingStock: used.remainingStock, orderType });
      await tx.execute(sql`UPDATE catalog_items SET stock_quantity = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${item.catalogItemId}), 0), inventory_amount = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${item.catalogItemId}), 0) WHERE tenant_id = ${order.tenantId} AND id = ${item.catalogItemId}`);
    }
  });
  if (auditContext) for (const entry of auditEntries) await writeAuditLog({ actorId: auditContext.actorId, actorEmail: auditContext.actorEmail, actorRole: auditContext.actorRole, action: "INVENTORY_DEDUCTED", tenantId: order.tenantId, resourceType: "order", resourceId: String(order.id), metadata: { orderId: order.id, ...entry }, ipAddress: auditContext.ipAddress });
}
