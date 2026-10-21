import { and, asc, eq, inArray } from "drizzle-orm";
import { db, catalogItemsTable, orderItemsTable } from "@workspace/db";
import { isCatalogItemForSale } from "./catalogEligibility";

export class OrderCatalogUnavailableError extends Error {
  readonly status = 409;
  readonly statusCode = 409;
  readonly code = "CATALOG_ITEM_UNAVAILABLE";
  constructor() { super("One or more order items are no longer available for purchase"); }
}

/** Call inside the payment transaction, before any tender or provider mutation. */
export async function requireOrderCatalogForSale(
  tx: Pick<typeof db, "select">,
  order: { id: number; tenantId: number },
): Promise<void> {
  const items = await tx.select({ catalogItemId: orderItemsTable.catalogItemId })
    .from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const ids = [...new Set(items.map(item => item.catalogItemId))];
  if (ids.length === 0) throw new OrderCatalogUnavailableError();
  const products = await tx.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, order.tenantId), inArray(catalogItemsTable.id, ids)))
    .orderBy(asc(catalogItemsTable.id)).for("update");
  // Lock in ID order through payment commit. Finalization also updates catalog
  // stock, so take update locks now to avoid competing shared-lock upgrades.
  if (products.length !== ids.length || products.some(product => !isCatalogItemForSale(product))) {
    throw new OrderCatalogUnavailableError();
  }
}
