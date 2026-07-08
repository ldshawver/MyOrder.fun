import { and, eq, sql } from "drizzle-orm";
import { db, inventoryLocationsTable, inventoryReservationsTable } from "@workspace/db";
import { type CheckoutInventoryLocationDeduction, type InventoryOrderType } from "./inventoryBalances";
import { deductInventoryBalanceThroughAuthority } from "./inventoryAuthority";
import { assertKernelCatalogItemId, executeTransaction, reservationIdempotencyKey } from "./inventoryKernel";

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
      "idempotency_key" text,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id")`);
  await db.execute(sql`ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "idempotency_key" text`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_idempotency_key_idx" ON "inventory_reservations" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_active_idx" ON "inventory_reservations" ("catalog_item_id", "location_id", "status", "expires_at")`);
}

export async function releaseExpiredInventoryReservations(executor: ReservationExecutor = db): Promise<number> {
  return executeTransaction(executor, "inventoryReservations.releaseExpired", async tx => {
    const released = await tx
      .update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(
        eq(inventoryReservationsTable.status, "reserved"),
        sql`${inventoryReservationsTable.expiresAt} <= now()`,
      ))
      .returning({ id: inventoryReservationsTable.id });
    return released.length;
  });
}

export async function reserveCheckoutInventoryByOrderType(
  executor: ReservationExecutor,
  tenantId: number,
  orderId: number,
  productId: number,
  quantity: number,
  orderType: InventoryOrderType,
): Promise<CheckoutInventoryLocationDeduction[] | null> {
  assertKernelCatalogItemId(productId, "checkout.inventoryReservation.orderTypeAware");
  return executeTransaction(executor, "inventoryReservations.reserveCheckout", async tx => {
  await releaseExpiredInventoryReservations(tx);
  const requestedQuantity = Number(quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error(`Invalid checkout inventory reservation quantity for catalogItemId ${productId}`);
  }

  const existingReservations = await tx.select({
    locationId: inventoryReservationsTable.locationId,
    quantity: inventoryReservationsTable.quantity,
  })
    .from(inventoryReservationsTable)
    .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.catalogItemId, productId), eq(inventoryReservationsTable.status, "reserved"), sql`${inventoryReservationsTable.expiresAt} > now()`));
  const existingQuantity = existingReservations.reduce((sum, reservation) => sum + Number(reservation.quantity ?? 0), 0);
  if (existingQuantity >= requestedQuantity) {
    return existingReservations.map(reservation => ({ locationId: reservation.locationId, locationName: null, quantity: Number(reservation.quantity), remainingStock: 0 }));
  }

  const balanceRows = rowsFrom<LockedBalanceRow>(await tx.execute(sql`
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
    ORDER BY array_position(ARRAY[${sql.join([...ORDER_LOCATION_POLICY[orderType]], sql`, `)}]::text[], il.name) NULLS LAST, il.display_order ASC, il.id ASC
    FOR UPDATE OF ib
  `));

  let remaining = requestedQuantity;
  const expiresAt = new Date(Date.now() + Math.max(1, RESERVATION_TTL_MINUTES) * 60_000);
  const reservations: CheckoutInventoryLocationDeduction[] = [];
  for (const row of balanceRows) {
    if (remaining <= 0) break;
    const [{ reservedQuantity = 0 } = { reservedQuantity: 0 }] = rowsFrom<ReservedQuantityRow>(await tx.execute(sql`
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
    await tx.insert(inventoryReservationsTable).values({
      orderId,
      catalogItemId: productId,
      locationId: row.locationId,
      quantity: reserveQuantity,
      status: "reserved",
      idempotencyKey: reservationIdempotencyKey({ orderId, catalogItemId: productId, locationId: row.locationId, orderType }),
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
    await tx.update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.catalogItemId, productId), eq(inventoryReservationsTable.status, "reserved")));
    return null;
  }
  return reservations;
  });
}

export async function confirmInventoryReservationsForOrder(
  executor: ReservationExecutor,
  orderId: number,
): Promise<Array<CheckoutInventoryLocationDeduction & { productId: number }>> {
  return executeTransaction(executor, "inventoryReservations.confirm", async tx => {
  await releaseExpiredInventoryReservations(tx);
  const reservations = await tx
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

  if (reservations.length === 0) {
    const confirmedReservations = await tx
      .select({
        id: inventoryReservationsTable.id,
        productId: inventoryReservationsTable.catalogItemId,
        locationId: inventoryReservationsTable.locationId,
        quantity: inventoryReservationsTable.quantity,
        locationName: inventoryLocationsTable.name,
      })
      .from(inventoryReservationsTable)
      .innerJoin(inventoryLocationsTable, eq(inventoryLocationsTable.id, inventoryReservationsTable.locationId))
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "confirmed")));
    return confirmedReservations.map(reservation => ({
      productId: reservation.productId,
      locationId: reservation.locationId,
      locationName: reservation.locationName,
      quantity: reservation.quantity,
      remainingStock: 0,
    }));
  }

  const deductions: Array<CheckoutInventoryLocationDeduction & { productId: number }> = [];
  for (const reservation of reservations) {
    await tx.update(inventoryReservationsTable)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(inventoryReservationsTable.id, reservation.id));
    const updated = await deductInventoryBalanceThroughAuthority(tx, {
      productId: reservation.productId,
      locationId: reservation.locationId,
      context: "inventoryReservations.confirm",
      quantity: reservation.quantity,
      ignoreReservationIds: [reservation.id],
    });
    if (!updated) throw new Error(`Reserved inventory could not be confirmed for catalogItemId ${reservation.productId}`);
    deductions.push({
      productId: reservation.productId,
      locationId: reservation.locationId,
      locationName: reservation.locationName,
      quantity: reservation.quantity,
      remainingStock: updated.remainingStock,
    });
  }
  return deductions;
  });
}

export async function releaseInventoryReservationsForOrder(executor: ReservationExecutor, orderId: number): Promise<number> {
  return executeTransaction(executor, "inventoryReservations.releaseOrder", async tx => {
    const released = await tx.update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "reserved")))
      .returning({ id: inventoryReservationsTable.id });
    return released.length;
  });
}
