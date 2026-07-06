import { and, eq, sql } from "drizzle-orm";
import { db, inventoryBalancesTable, inventoryLocationsTable, inventoryReservationsTable } from "@workspace/db";
import { type CheckoutInventoryLocationDeduction, type InventoryOrderType } from "./inventoryBalances";
import { assertCatalogIdInventoryLookup } from "./inventoryIdentityGuard";

type ReservationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReservationExecutor = typeof db | ReservationTransaction;

const RESERVATION_TTL_MINUTES = Number(process.env.POS_INVENTORY_RESERVATION_TTL_MINUTES ?? "15");
const ORDER_LOCATION_POLICY: Record<InventoryOrderType, readonly string[]> = {
  WALK_IN: ["Storefront", "CSR Sales Box 1", "CSR Sales Box 2", "Backstock"],
  CSR: ["CSR Sales Box 1", "CSR Sales Box 2", "Storefront", "Backstock"],
  ONLINE: ["Backstock", "Storefront", "CSR Sales Box 1", "CSR Sales Box 2"],
};

type LockedBalanceRow = {
  id: number;
  locationId: number;
  locationName: string | null;
  quantityOnHand: unknown;
};

type ReservedQuantityRow = { reservedQuantity: unknown };

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | undefined;
  return maybe?.rows ?? [];
}

export async function ensureInventoryReservationsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "inventory_reservations" (
      "id" serial PRIMARY KEY,
      "order_id" integer NOT NULL REFERENCES "orders"("id"),
      "catalog_item_id" integer NOT NULL REFERENCES "catalog_items"("id"),
      "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
      "quantity" integer NOT NULL,
      "status" text NOT NULL DEFAULT 'reserved',
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_active_idx" ON "inventory_reservations" ("catalog_item_id", "location_id", "status", "expires_at")`);
}

export async function releaseExpiredInventoryReservations(executor: ReservationExecutor = db): Promise<number> {
  const released = await executor
    .update(inventoryReservationsTable)
    .set({ status: "released", updatedAt: new Date() })
    .where(and(
      eq(inventoryReservationsTable.status, "reserved"),
      sql`${inventoryReservationsTable.expiresAt} <= now()`,
    ))
    .returning({ id: inventoryReservationsTable.id });
  return released.length;
}

export async function reserveCheckoutInventoryByOrderType(
  executor: ReservationExecutor,
  tenantId: number,
  orderId: number,
  productId: number,
  quantity: number,
  orderType: InventoryOrderType,
): Promise<CheckoutInventoryLocationDeduction[] | null> {
  assertCatalogIdInventoryLookup(productId, "checkout.inventoryReservation.orderTypeAware");
  await releaseExpiredInventoryReservations(executor);
  const requestedQuantity = Number(quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error(`Invalid checkout inventory reservation quantity for catalogItemId ${productId}`);
  }

  const balanceRows = rowsFrom<LockedBalanceRow>(await executor.execute(sql`
    SELECT
      ib.id AS "id",
      ib.location_id AS "locationId",
      il.name AS "locationName",
      ib.quantity_on_hand AS "quantityOnHand"
    FROM inventory_balances ib
    JOIN inventory_locations il ON il.tenant_id = ib.tenant_id AND il.id = ib.location_id
    WHERE ib.tenant_id = ${tenantId}
      AND ib.product_id = ${productId}
      AND ib.inventory_kind = 'sellable_catalog'
      AND ib.is_sellable = true
      AND ib.quarantined_at IS NULL
      AND il.is_active = true
    ORDER BY array_position(${[...ORDER_LOCATION_POLICY[orderType]]}::text[], il.name) NULLS LAST, il.display_order ASC, il.id ASC
    FOR UPDATE OF ib
  `));

  let remaining = requestedQuantity;
  const expiresAt = new Date(Date.now() + Math.max(1, RESERVATION_TTL_MINUTES) * 60_000);
  const reservations: CheckoutInventoryLocationDeduction[] = [];
  for (const row of balanceRows) {
    if (remaining <= 0) break;
    const [{ reservedQuantity = 0 } = { reservedQuantity: 0 }] = rowsFrom<ReservedQuantityRow>(await executor.execute(sql`
      SELECT COALESCE(SUM(quantity), 0)::int AS "reservedQuantity"
      FROM inventory_reservations
      WHERE catalog_item_id = ${productId}
        AND location_id = ${row.locationId}
        AND status = 'reserved'
        AND expires_at > now()
    `));
    const available = Number(row.quantityOnHand ?? 0) - Number(reservedQuantity ?? 0);
    if (available <= 0) continue;
    const reserveQuantity = Math.min(remaining, available);
    await executor.insert(inventoryReservationsTable).values({
      orderId,
      catalogItemId: productId,
      locationId: row.locationId,
      quantity: reserveQuantity,
      status: "reserved",
      expiresAt,
    });
    reservations.push({
      locationId: row.locationId,
      locationName: row.locationName,
      quantity: reserveQuantity,
      remainingStock: available - reserveQuantity,
    });
    remaining -= reserveQuantity;
  }

  if (remaining > 0) {
    await executor.update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.catalogItemId, productId), eq(inventoryReservationsTable.status, "reserved")));
    return null;
  }
  return reservations;
}

export async function confirmInventoryReservationsForOrder(
  executor: ReservationExecutor,
  orderId: number,
): Promise<Array<CheckoutInventoryLocationDeduction & { productId: number }>> {
  await releaseExpiredInventoryReservations(executor);
  const reservations = await executor
    .select({
      id: inventoryReservationsTable.id,
      productId: inventoryReservationsTable.catalogItemId,
      locationId: inventoryReservationsTable.locationId,
      quantity: inventoryReservationsTable.quantity,
      locationName: inventoryLocationsTable.name,
    })
    .from(inventoryReservationsTable)
    .innerJoin(inventoryLocationsTable, eq(inventoryLocationsTable.id, inventoryReservationsTable.locationId))
    .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "reserved"), sql`${inventoryReservationsTable.expiresAt} > now()`));

  const deductions: Array<CheckoutInventoryLocationDeduction & { productId: number }> = [];
  for (const reservation of reservations) {
    const [updated] = await executor
      .update(inventoryBalancesTable)
      .set({ quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(reservation.quantity)}` })
      .where(and(
        eq(inventoryBalancesTable.productId, reservation.productId),
        eq(inventoryBalancesTable.locationId, reservation.locationId),
        sql`${inventoryBalancesTable.quantityOnHand} >= ${String(reservation.quantity)}`,
      ))
      .returning({ quantityOnHand: inventoryBalancesTable.quantityOnHand });
    if (!updated) throw new Error(`Reserved inventory could not be confirmed for catalogItemId ${reservation.productId}`);
    await executor.update(inventoryReservationsTable)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(inventoryReservationsTable.id, reservation.id));
    deductions.push({
      productId: reservation.productId,
      locationId: reservation.locationId,
      locationName: reservation.locationName,
      quantity: reservation.quantity,
      remainingStock: Number(updated.quantityOnHand ?? 0),
    });
  }
  return deductions;
}

export async function releaseInventoryReservationsForOrder(executor: ReservationExecutor, orderId: number): Promise<number> {
  const released = await executor.update(inventoryReservationsTable)
    .set({ status: "released", updatedAt: new Date() })
    .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "reserved")))
    .returning({ id: inventoryReservationsTable.id });
  return released.length;
}
