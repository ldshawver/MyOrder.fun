import { eq, sql } from "drizzle-orm";
import { db, orderItemsTable, ordersTable } from "@workspace/db";
import { writeAuditLog } from "../lib/auth";
import { type InventoryOrderType } from "../lib/inventoryBalances";
import { confirmInventoryReservationsForOrder, ensureInventoryReservationsTable, reserveCheckoutInventoryByOrderType } from "../lib/inventoryReservations";
import { quantityText, quantityUnits } from "../lib/exactQuantity";

function rows<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : ((value as { rows?: T[] } | undefined)?.rows ?? []); }

export class PaymentInventoryError extends Error {
  constructor(public readonly catalogItemId: number) { super(`Insufficient inventory for catalog item ${catalogItemId}`); this.name = "PaymentInventoryError"; }
}

function orderTypeForPaidDeduction(order: typeof ordersTable.$inferSelect): InventoryOrderType {
  const raw = order.orderType;
  if (raw === "WALK_IN" || raw === "CSR" || raw === "ONLINE") return raw;
  return order.deliveryMethod === "csr_delivery" ? "CSR" : "ONLINE";
}

export type PaymentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reacquire released reservations before a payment retry can contact PayPal. */
export async function ensurePaidOrderInventoryReserved(tx: PaymentTransaction, order: typeof ordersTable.$inferSelect): Promise<void> {
  const items = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  for (const item of items) {
    const reservationItemId = item.inventoryItemId == null ? null : item.id;
    const consumed = rows<{ id: number }>(await tx.execute(sql`
      SELECT id FROM inventory_reservations WHERE order_id = ${order.id}
        AND (order_item_id = ${item.id} OR (${reservationItemId === null} AND order_item_id IS NULL AND catalog_item_id = ${item.catalogItemId}))
        AND status = 'confirmed' LIMIT 1
    `));
    if (consumed.length) continue;
    const source = item.inventoryItemId == null ? undefined : rows<{ catalogItemId: number; locationEvaluation: string }>(await tx.execute(sql`
      SELECT ii.catalog_item_id AS "catalogItemId", cp.location_evaluation AS "locationEvaluation"
      FROM inventory_items ii JOIN catalogue_options co ON co.tenant_id = ii.tenant_id AND co.inventory_item_id = ii.id
      JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
      WHERE ii.tenant_id = ${order.tenantId} AND ii.id = ${item.inventoryItemId} AND co.id = ${item.optionId} LIMIT 1
    `))[0];
    if (item.inventoryItemId != null && !source) throw new PaymentInventoryError(item.catalogItemId);
    const inventoryCatalogItemId = source?.catalogItemId ?? item.catalogItemId;
    const physicalQuantity = item.inventoryQuantitySnapshot ?? quantityText(quantityUnits(String(item.quantity)));
    const reservations = await reserveCheckoutInventoryByOrderType(tx, order.tenantId, order.id,
      inventoryCatalogItemId, physicalQuantity, orderTypeForPaidDeduction(order), reservationItemId ?? undefined,
      source?.locationEvaluation === "PER_LOCATION" ? "PER_LOCATION" : "COMBINED_LOCATIONS");
    if (!reservations) throw new PaymentInventoryError(item.catalogItemId);
    await tx.update(orderItemsTable).set({ inventoryDeductions: reservations }).where(eq(orderItemsTable.id, item.id));
  }
}

export async function deductPaidOrderInventory(order: typeof ordersTable.$inferSelect, auditContext?: { actorId: number; actorEmail: string | null | undefined; actorRole: string; ipAddress?: string }, executor?: PaymentTransaction): Promise<void> {
  if (!executor) await ensureInventoryReservationsTable();
  const auditEntries: Array<{ productId: number; locationUsed: string | null; locationId: number; quantity: number; remainingStock: number; orderType: InventoryOrderType }> = [];
  const deduct = async (tx: PaymentTransaction) => {
    const items = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
    await ensurePaidOrderInventoryReserved(tx, order);
    if (!auditContext) throw new Error("Inventory sale confirmation requires an audit actor");
    const confirmed = await confirmInventoryReservationsForOrder(tx, order.tenantId, order.id, { id: auditContext.actorId, email: auditContext.actorEmail, role: auditContext.actorRole, ipAddress: auditContext.ipAddress });
    for (const item of items) {
      if (!item.catalogItemId) continue;
      const orderType = orderTypeForPaidDeduction(order);
      const details = confirmed.filter(row => row.orderItemId === item.id || (row.orderItemId == null && row.productId === item.catalogItemId));
      if (details.length === 0) throw new PaymentInventoryError(item.catalogItemId);
      await tx.update(orderItemsTable).set({ inventoryDeductions: details.map(({ productId: _id, orderItemId: _orderItemId, ...row }) => row) }).where(eq(orderItemsTable.id, item.id));
      for (const used of details) auditEntries.push({ productId: item.catalogItemId, locationUsed: used.locationName, locationId: used.locationId, quantity: used.quantity, remainingStock: used.remainingStock, orderType });
      const inventoryCatalogItemId = details[0].productId;
      await tx.execute(sql`UPDATE catalog_items SET stock_quantity = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${inventoryCatalogItemId}), 0), inventory_amount = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id = ${order.tenantId} AND product_id = ${inventoryCatalogItemId}), 0) WHERE tenant_id = ${order.tenantId} AND id IN (SELECT catalog_item_id FROM catalogue_options WHERE tenant_id = ${order.tenantId} AND inventory_item_id = ${item.inventoryItemId ?? null} UNION SELECT ${inventoryCatalogItemId})`);
    }
  };
  if (executor) await deduct(executor);
  else await db.transaction(deduct);
  if (!executor && auditContext) for (const entry of auditEntries) await writeAuditLog({ actorId: auditContext.actorId, actorEmail: auditContext.actorEmail, actorRole: auditContext.actorRole, action: "INVENTORY_DEDUCTED", tenantId: order.tenantId, resourceType: "order", resourceId: String(order.id), metadata: { orderId: order.id, ...entry }, ipAddress: auditContext.ipAddress });
}
