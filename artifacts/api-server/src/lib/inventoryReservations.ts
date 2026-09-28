import { and, eq, sql } from "drizzle-orm";
import { db, inventoryLocationsTable, inventoryMovementsTable, inventoryReservationsTable, ordersTable } from "@workspace/db";
import { type CheckoutInventoryLocationDeduction, type InventoryOrderType } from "./inventoryBalances";
import { assertKernelCatalogItemId, executeTransaction, reservationIdempotencyKey } from "./inventoryKernel";
import { postInventoryMovement, type InventoryMovementActor } from "./inventoryMovementLedger";
import { quantityText, quantityUnits } from "./exactQuantity";

type ReservationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReservationExecutor = typeof db | ReservationTransaction;

const RESERVATION_TTL_MINUTES = Number(process.env.POS_INVENTORY_RESERVATION_TTL_MINUTES ?? "15");
let reservationsSchemaEnsured = false;
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
  if (reservationsSchemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "inventory_reservations" (
      "id" serial PRIMARY KEY,
      "order_id" integer NOT NULL REFERENCES "orders"("id"),
      "catalog_item_id" integer NOT NULL REFERENCES "catalog_items"("id"),
      "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
      "quantity" numeric(20, 6) NOT NULL,
      "status" text NOT NULL DEFAULT 'reserved',
      "idempotency_key" text,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id")`);
  await db.execute(sql`ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "idempotency_key" text`);
  await db.execute(sql`ALTER TABLE "inventory_reservations" ALTER COLUMN "quantity" TYPE numeric(20, 6) USING "quantity"::numeric(20, 6)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_idempotency_key_idx" ON "inventory_reservations" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_reservations_active_idx" ON "inventory_reservations" ("catalog_item_id", "location_id", "status", "expires_at")`);
  reservationsSchemaEnsured = true;
}

export async function releaseExpiredInventoryReservations(executor: ReservationExecutor, tenantId: number): Promise<number> {
  return executeTransaction(tenantId, executor, "inventoryReservations.releaseExpired", async tx => {
    const released = rowsFrom<{ id: number }>(await tx.execute(sql`
      UPDATE inventory_reservations r SET status = 'released', updated_at = now()
      WHERE r.status = 'reserved' AND r.expires_at <= now()
        AND EXISTS (SELECT 1 FROM orders o WHERE o.id = r.order_id AND o.tenant_id = ${tenantId})
        AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId}
          AND p.state IN ('creating','created','approved','capturing','reconciliation_required'))
      RETURNING r.id
    `));
    return released.length;
  });
}

export async function reserveCheckoutInventoryByOrderType(
  executor: ReservationExecutor,
  tenantId: number,
  orderId: number,
  productId: number,
  quantity: string | number,
  orderType: InventoryOrderType,
  orderItemId?: number,
  locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS" = "COMBINED_LOCATIONS",
): Promise<CheckoutInventoryLocationDeduction[] | null> {
  assertKernelCatalogItemId(productId, "checkout.inventoryReservation.orderTypeAware");
  return executeTransaction(tenantId, executor, "inventoryReservations.reserveCheckout", async tx => {
  await releaseExpiredInventoryReservations(tx, tenantId);
  const requestedQuantity = quantityUnits(quantity);
  if (requestedQuantity <= 0n) {
    throw new Error(`Invalid checkout inventory reservation quantity for catalogItemId ${productId}`);
  }
  const owner = rowsFrom<{ id: number }>(await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} FOR UPDATE`));
  const product = rowsFrom<{ id: number }>(await tx.execute(sql`SELECT id FROM catalog_items WHERE id = ${productId} AND tenant_id = ${tenantId}`));
  if (!owner.length || !product.length) throw new Error("Order or catalog item is not in the authorized tenant");

  const existingReservations = await tx.select({
    locationId: inventoryReservationsTable.locationId,
    quantity: inventoryReservationsTable.quantity,
  })
    .from(inventoryReservationsTable)
    .innerJoin(inventoryLocationsTable, and(eq(inventoryLocationsTable.id, inventoryReservationsTable.locationId), eq(inventoryLocationsTable.tenantId, tenantId)))
    .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.catalogItemId, productId),
      orderItemId == null ? sql`${inventoryReservationsTable.orderItemId} IS NULL` : eq(inventoryReservationsTable.orderItemId, orderItemId),
      eq(inventoryReservationsTable.status, "reserved"), sql`(${inventoryReservationsTable.expiresAt} > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = ${orderId} AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))`));
  const existingQuantity = existingReservations.reduce((sum, reservation) => sum + quantityUnits(reservation.quantity), 0n);
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
    if (remaining <= 0n) break;
    const [{ reservedQuantity = 0 } = { reservedQuantity: 0 }] = rowsFrom<ReservedQuantityRow>(await tx.execute(sql`
      SELECT COALESCE(SUM(r.quantity), 0)::numeric AS "reservedQuantity"
      FROM inventory_reservations r
      JOIN orders o ON o.id = r.order_id AND o.tenant_id = ${tenantId}
      WHERE r.catalog_item_id = ${productId}
        AND r.location_id = ${row.locationId}
        AND r.status = 'reserved'
        AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))
    `));
    const available = quantityUnits(String(row.quantityOnHand ?? 0)) - quantityUnits(String(reservedQuantity ?? 0));
    if (available <= 0n) continue;
    if (locationEvaluation === "PER_LOCATION" && available < remaining) continue;
    const reserveQuantity = remaining < available ? remaining : available;
    const key = reservationIdempotencyKey({ orderId, catalogItemId: productId, locationId: row.locationId, orderType, orderItemId });
    const inserted = rowsFrom<{ id: number }>(await tx.execute(sql`
      INSERT INTO inventory_reservations (order_id, order_item_id, catalog_item_id, location_id, quantity, status, idempotency_key, expires_at)
      VALUES (${orderId}, ${orderItemId ?? null}, ${productId}, ${row.locationId}, ${quantityText(reserveQuantity)}::numeric, 'reserved', ${key}, ${expiresAt})
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET quantity = EXCLUDED.quantity, status = 'reserved', expires_at = EXCLUDED.expires_at, updated_at = now()
      WHERE inventory_reservations.status = 'released'
      RETURNING id`));
    if (!inserted.length) throw new Error("Reservation identity conflicts with consumed inventory");
    reservations.push({
      locationId: row.locationId,
      locationName: row.locationName,
      quantity: Number(quantityText(reserveQuantity)),
      remainingStock: Number(quantityText(available - reserveQuantity)),
    });
    remaining -= reserveQuantity;
  }

  if (remaining > 0n) {
    await tx.update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.catalogItemId, productId),
        orderItemId == null ? sql`${inventoryReservationsTable.orderItemId} IS NULL` : eq(inventoryReservationsTable.orderItemId, orderItemId),
        eq(inventoryReservationsTable.status, "reserved")));
    return null;
  }
  return reservations;
  });
}

export async function confirmInventoryReservationsForOrder(
  executor: ReservationExecutor,
  tenantId: number,
  orderId: number,
  actor: InventoryMovementActor,
): Promise<Array<CheckoutInventoryLocationDeduction & { productId: number; orderItemId: number | null }>> {
  return executeTransaction(tenantId, executor, "inventoryReservations.confirm", async tx => {
  await releaseExpiredInventoryReservations(tx, tenantId);
  const owner = rowsFrom<{ id: number }>(await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} FOR UPDATE`));
  if (!owner.length) throw new Error("Order is not in the authorized tenant");
  const reservations = await tx
    .select({
      id: inventoryReservationsTable.id,
      orderItemId: inventoryReservationsTable.orderItemId,
      productId: inventoryReservationsTable.catalogItemId,
      locationId: inventoryReservationsTable.locationId,
      quantity: inventoryReservationsTable.quantity,
      locationName: inventoryLocationsTable.name,
    })
    .from(inventoryReservationsTable)
    .innerJoin(inventoryLocationsTable, and(eq(inventoryLocationsTable.id, inventoryReservationsTable.locationId), eq(inventoryLocationsTable.tenantId, tenantId)))
    .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "reserved"), sql`(${inventoryReservationsTable.expiresAt} > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = ${orderId} AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))`));

  if (reservations.length === 0) {
    const confirmedReservations = await tx
      .select({
        id: inventoryReservationsTable.id,
        orderItemId: inventoryReservationsTable.orderItemId,
        productId: inventoryReservationsTable.catalogItemId,
        locationId: inventoryReservationsTable.locationId,
        quantity: inventoryReservationsTable.quantity,
        locationName: inventoryLocationsTable.name,
      })
      .from(inventoryReservationsTable)
      .innerJoin(inventoryLocationsTable, and(eq(inventoryLocationsTable.id, inventoryReservationsTable.locationId), eq(inventoryLocationsTable.tenantId, tenantId)))
      .where(and(eq(inventoryReservationsTable.orderId, orderId), eq(inventoryReservationsTable.status, "confirmed")));
    return confirmedReservations.map(reservation => ({
      productId: reservation.productId,
      orderItemId: reservation.orderItemId,
      locationId: reservation.locationId,
      locationName: reservation.locationName,
      quantity: Number(reservation.quantity),
      remainingStock: 0,
    }));
  }

  const deductions: Array<CheckoutInventoryLocationDeduction & { productId: number; orderItemId: number | null }> = [];
  const [order] = await tx.select({ tenantId: ordersTable.tenantId }).from(ordersTable).where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId))).limit(1);
  if (!order) throw new Error(`Order ${orderId} was not found while confirming inventory`);
  for (const reservation of reservations) {
    await tx.update(inventoryReservationsTable)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(inventoryReservationsTable.id, reservation.id), eq(inventoryReservationsTable.status, "reserved")));
    const movement = await postInventoryMovement(tx, {
      tenantId: order.tenantId, actor, entityType: "catalog", itemId: reservation.productId, locationId: reservation.locationId,
      movementType: "sale", quantity: String(reservation.quantity), sourceType: "order", sourceId: String(orderId), orderId,
      reasonCode: "sale", reasonText: "Completed order inventory consumption", idempotencyKey: `sale:${orderId}:${reservation.id}`,
    });
    deductions.push({
      productId: reservation.productId,
      orderItemId: reservation.orderItemId,
      locationId: reservation.locationId,
      locationName: reservation.locationName,
      quantity: reservation.quantity,
      remainingStock: Number(movement.postQuantity),
    });
  }
  return deductions;
  });
}

export async function releaseInventoryReservationsForOrder(executor: ReservationExecutor, tenantId: number, orderId: number): Promise<number> {
  return executeTransaction(tenantId, executor, "inventoryReservations.releaseOrder", async tx => {
    const owner = rowsFrom<{ id: number }>(await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} FOR UPDATE`));
    if (!owner.length) throw new Error("Order is not in the authorized tenant");
    const unsafe = rowsFrom<{ blocked: boolean }>(await tx.execute(sql`
      SELECT EXISTS (SELECT 1 FROM orders o WHERE o.id = ${orderId} AND o.tenant_id = ${tenantId} AND o.payment_status = 'paid')
        OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = ${orderId} AND p.tenant_id = ${tenantId}
          AND p.state IN ('creating','created','approved','capturing','reconciliation_required')) AS blocked`))[0]?.blocked;
    if (unsafe) throw new Error("Inventory cannot be released while payment is paid or unresolved");
    const released = await tx.update(inventoryReservationsTable)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(
        eq(inventoryReservationsTable.orderId, orderId),
        sql`${inventoryReservationsTable.status} IN ('reserved', 'confirmed')`,
        // A confirmed reservation with a sale movement has already consumed
        // inventory and requires an audited reconciliation, not a silent
        // release. Confirmed holds without a sale are still temporary
        // availability state and are safe to release on unpaid cancellation.
        sql`NOT EXISTS (
          SELECT 1 FROM ${inventoryMovementsTable}
          WHERE ${inventoryMovementsTable.orderId} = ${orderId}
            AND ${inventoryMovementsTable.movementType} = 'sale'
            AND ${inventoryMovementsTable.catalogItemId} = ${inventoryReservationsTable.catalogItemId}
            AND ${inventoryMovementsTable.locationId} = ${inventoryReservationsTable.locationId}
        )`,
      ))
      .returning({ id: inventoryReservationsTable.id });
    return released.length;
  });
}
