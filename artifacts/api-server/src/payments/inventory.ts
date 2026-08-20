import { eq, sql } from "drizzle-orm";
import { db, inventoryReservationsTable, labTechShiftsTable, orderItemsTable, ordersTable } from "@workspace/db";
import { writeAuditLog } from "../lib/auth";
import { type InventoryOrderType } from "../lib/inventoryBalances";
import { confirmInventoryReservationsForOrder, ensureInventoryReservationsTable, reserveCheckoutInventoryByOrderType } from "../lib/inventoryReservations";

export class PaymentInventoryError extends Error {
  constructor(public readonly catalogItemId: number) { super(`Insufficient inventory for catalog item ${catalogItemId}`); this.name = "PaymentInventoryError"; }
}

function orderTypeForPaidDeduction(order: typeof ordersTable.$inferSelect): InventoryOrderType {
  const raw = order.orderType;
  if (raw === "WALK_IN" || raw === "CSR" || raw === "ONLINE") return raw;
  return order.deliveryMethod === "csr_delivery" ? "CSR" : "ONLINE";
}

export async function deductPaidOrderInventory(order: typeof ordersTable.$inferSelect, auditContext?: { actorId: number; actorEmail: string | null | undefined; actorRole: string; ipAddress?: string }): Promise<void> {
  const method = String(order.selectedPaymentMethod ?? order.paymentMethod ?? "").toLowerCase();
  if (method === "cash") return;
  if (!order.assignedShiftId || order.routeSource !== "active_csr") return;
  await ensureInventoryReservationsTable();
  const [shift] = await db.select({ boxAssignmentId: labTechShiftsTable.boxAssignmentId }).from(labTechShiftsTable).where(eq(labTechShiftsTable.id, order.assignedShiftId)).limit(1);
  if (!shift?.boxAssignmentId) return;
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const auditEntries: Array<{ productId: number; locationUsed: string | null; locationId: number; quantity: number; remainingStock: number; orderType: InventoryOrderType }> = [];
  await db.transaction(async tx => {
    const existing = await tx.select({ id: inventoryReservationsTable.id }).from(inventoryReservationsTable).where(eq(inventoryReservationsTable.orderId, order.id)).limit(1);
    if (existing.length === 0) {
      for (const item of items) {
        if (!item.catalogItemId) continue;
        const reservations = await reserveCheckoutInventoryByOrderType(tx, order.tenantId, order.id, item.catalogItemId, Number(item.quantity), orderTypeForPaidDeduction(order));
        if (!reservations) throw new PaymentInventoryError(item.catalogItemId);
        await tx.update(orderItemsTable).set({ inventoryDeductions: reservations }).where(eq(orderItemsTable.id, item.id));
      }
    }
    const confirmed = await confirmInventoryReservationsForOrder(tx, order.id);
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
