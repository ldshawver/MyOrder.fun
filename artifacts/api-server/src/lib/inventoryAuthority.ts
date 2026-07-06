import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { executeTransaction } from "./inventoryKernel";

type AuthorityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AuthorityExecutor = typeof db | AuthorityTransaction;

export const POS_INVENTORY_STRICT_MODE = process.env.POS_INVENTORY_STRICT_MODE === "true";

type ReservationSumRow = { reservedQuantity: unknown };
type NegativeAvailabilityRow = { productId: number; locationId: number; quantityOnHand: unknown; activeReserved: unknown; available: unknown };
type OrphanReservationRow = { reservationId: number; orderId: number; catalogItemId: number; locationId: number; reason: string };
type MismatchedDeductionRow = { reservationId: number; orderId: number; catalogItemId: number; locationId: number; quantity: number };

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

export async function getActiveReservedQuantity(
  executor: AuthorityExecutor,
  productId: number,
  locationId: number,
  ignoreReservationIds: number[] = [],
): Promise<number> {
  const ignoreSql = ignoreReservationIds.length > 0 ? sql`AND id <> ALL(${ignoreReservationIds})` : sql``;
  const row = rowsFrom<ReservationSumRow>(await executor.execute(sql`
    SELECT COALESCE(SUM(quantity), 0)::numeric AS "reservedQuantity"
    FROM inventory_reservations
    WHERE catalog_item_id = ${productId}
      AND location_id = ${locationId}
      AND status = 'reserved'
      AND expires_at > now()
      ${ignoreSql}
  `))[0];
  return Number(row?.reservedQuantity ?? 0);
}

export async function assertInventoryBalanceWriteSafe(
  executor: AuthorityExecutor,
  params: { productId: number; locationId: number; nextQuantityOnHand: number; context: string; ignoreReservationIds?: number[] },
): Promise<void> {
  const activeReserved = await getActiveReservedQuantity(executor, params.productId, params.locationId, params.ignoreReservationIds ?? []);
  if (params.nextQuantityOnHand < activeReserved) {
    const message = `DIRECT INVENTORY WRITE BLOCKED — USE inventoryAuthority: productId ${params.productId} locationId ${params.locationId} next quantity ${params.nextQuantityOnHand} is below active reservations ${activeReserved}`;
    logger.error({ ...params, activeReserved, strict: POS_INVENTORY_STRICT_MODE }, message);
    throw new Error(message);
  }
}

export async function collectInventoryReconcileReport(): Promise<{
  orphanReservations: OrphanReservationRow[];
  negativeAvailability: NegativeAvailabilityRow[];
  mismatchedDeductions: MismatchedDeductionRow[];
  expiredReservations: number;
}> {
  const expiredReservations = Number(rowsFrom<{ count: unknown }>(await db.execute(sql`
    SELECT count(*)::int AS count
    FROM inventory_reservations
    WHERE status = 'reserved' AND expires_at <= now()
  `))[0]?.count ?? 0);

  const orphanReservations = rowsFrom<OrphanReservationRow>(await db.execute(sql`
    SELECT r.id AS "reservationId", r.order_id AS "orderId", r.catalog_item_id AS "catalogItemId", r.location_id AS "locationId",
      CASE
        WHEN o.id IS NULL THEN 'missing_order'
        WHEN ci.id IS NULL THEN 'missing_catalog_item'
        WHEN il.id IS NULL THEN 'missing_location'
        ELSE 'unknown'
      END AS "reason"
    FROM inventory_reservations r
    LEFT JOIN orders o ON o.id = r.order_id
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
    LEFT JOIN inventory_locations il ON il.id = r.location_id
    WHERE r.status = 'reserved'
      AND r.expires_at > now()
      AND (o.id IS NULL OR ci.id IS NULL OR il.id IS NULL)
  `));

  const negativeAvailability = rowsFrom<NegativeAvailabilityRow>(await db.execute(sql`
    SELECT ib.product_id AS "productId", ib.location_id AS "locationId", ib.quantity_on_hand AS "quantityOnHand",
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND r.expires_at > now()), 0) AS "activeReserved",
      ib.quantity_on_hand - COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND r.expires_at > now()), 0) AS "available"
    FROM inventory_balances ib
    LEFT JOIN inventory_reservations r ON r.catalog_item_id = ib.product_id AND r.location_id = ib.location_id
    GROUP BY ib.product_id, ib.location_id, ib.quantity_on_hand
    HAVING ib.quantity_on_hand < COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND r.expires_at > now()), 0)
  `));

  const mismatchedDeductions = rowsFrom<MismatchedDeductionRow>(await db.execute(sql`
    SELECT r.id AS "reservationId", r.order_id AS "orderId", r.catalog_item_id AS "catalogItemId", r.location_id AS "locationId", r.quantity::int AS "quantity"
    FROM inventory_reservations r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN order_items oi ON oi.order_id = r.order_id AND oi.catalog_item_id = r.catalog_item_id
    WHERE r.status = 'confirmed'
      AND (oi.id IS NULL OR oi.inventory_deductions IS NULL OR oi.inventory_deductions = '[]'::jsonb)
  `));

  return { orphanReservations, negativeAvailability, mismatchedDeductions, expiredReservations };
}

export async function reconcileInventoryState(): Promise<Awaited<ReturnType<typeof collectInventoryReconcileReport>> & { releasedExpiredReservations: number; releasedOrphanReservations: number }> {
  const report = await collectInventoryReconcileReport();
  const releasedExpiredReservations = await executeTransaction("inventoryAuthority.reconcile.releaseExpired", async tx => rowsFrom<{ id: number }>(await tx.execute(sql`
    UPDATE inventory_reservations
    SET status = 'released', updated_at = now()
    WHERE status = 'reserved' AND expires_at <= now()
    RETURNING id
  `)).length);
  const orphanIds = report.orphanReservations.map(row => row.reservationId);
  let releasedOrphanReservations = 0;
  if (orphanIds.length > 0) {
    releasedOrphanReservations = await executeTransaction("inventoryAuthority.reconcile.releaseOrphans", async tx => rowsFrom<{ id: number }>(await tx.execute(sql`
      UPDATE inventory_reservations
      SET status = 'released', updated_at = now()
      WHERE id = ANY(${orphanIds}) AND status = 'reserved'
      RETURNING id
    `)).length);
  }
  if (report.negativeAvailability.length > 0 || report.mismatchedDeductions.length > 0) {
    logger.error({ report }, "Inventory reconciliation detected unsafe inventory state");
  }
  return { ...report, releasedExpiredReservations, releasedOrphanReservations };
}


export async function upsertInventoryBalanceThroughAuthority(
  executor: AuthorityExecutor,
  params: { tenantId: number; productId: number; locationId: number; quantityOnHand: number; parLevel: number; context: string },
): Promise<void> {
  await executeTransaction(executor, params.context, async tx => {
    const existing = rowsFrom<{ id: number }>(await tx.execute(sql`
      SELECT id FROM inventory_balances
      WHERE tenant_id = ${params.tenantId}
        AND product_id = ${params.productId}
        AND location_id = ${params.locationId}
        AND inventory_kind = 'sellable_catalog'
        AND is_sellable = true
        AND quarantined_at IS NULL
      LIMIT 1
      FOR UPDATE
    `))[0];
    await assertInventoryBalanceWriteSafe(tx, {
      productId: params.productId,
      locationId: params.locationId,
      nextQuantityOnHand: params.quantityOnHand,
      context: params.context,
    });
    if (existing) {
      await tx.execute(sql`
        UPDATE inventory_balances
        SET quantity_on_hand = ${String(params.quantityOnHand)},
            par_level = ${String(params.parLevel)},
            inventory_kind = 'sellable_catalog',
            updated_at = now()
        WHERE tenant_id = ${params.tenantId} AND id = ${existing.id}
      `);
      return;
    }
    await tx.execute(sql`
      INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
      VALUES (${params.tenantId}, ${params.productId}, ${params.locationId}, ${String(params.quantityOnHand)}, ${String(params.parLevel)}, 'sellable_catalog', true, now())
      ON CONFLICT DO NOTHING
    `);
  });
}

export async function deductInventoryBalanceThroughAuthority(
  executor: AuthorityExecutor,
  params: { productId: number; locationId: number; quantity: number; context: string; ignoreReservationIds?: number[] },
): Promise<{ remainingStock: number } | null> {
  return executeTransaction(executor, params.context, async tx => {
    const current = rowsFrom<{ id: number; quantityOnHand: unknown }>(await tx.execute(sql`
      SELECT id, quantity_on_hand AS "quantityOnHand"
      FROM inventory_balances
      WHERE product_id = ${params.productId} AND location_id = ${params.locationId}
      LIMIT 1
      FOR UPDATE
    `))[0];
    if (!current) return null;
    const nextQuantityOnHand = Number(current.quantityOnHand ?? 0) - Number(params.quantity);
    await assertInventoryBalanceWriteSafe(tx, {
      productId: params.productId,
      locationId: params.locationId,
      nextQuantityOnHand,
      context: params.context,
      ignoreReservationIds: params.ignoreReservationIds,
    });
    const updated = rowsFrom<{ quantityOnHand: unknown }>(await tx.execute(sql`
      UPDATE inventory_balances
      SET quantity_on_hand = quantity_on_hand - ${String(params.quantity)}, updated_at = now()
      WHERE id = ${current.id}
        AND quantity_on_hand >= ${String(params.quantity)}
      RETURNING quantity_on_hand AS "quantityOnHand"
    `))[0];
    return updated ? { remainingStock: Number(updated.quantityOnHand ?? 0) } : null;
  });
}

export async function bootstrapMissingInventoryBalancesThroughAuthority(tenantId: number, requiredLocationNames: readonly string[]): Promise<number> {
  return executeTransaction("inventoryAuthority.bootstrapMissingInventoryBalances", async tx => {
    const inserted = rowsFrom<{ id: number }>(await tx.execute(sql`
      INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
      SELECT ${tenantId}, ci.id, il.id, 0, 0, 'sellable_catalog', true, now()
      FROM catalog_items ci
      JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.name = ANY(${[...requiredLocationNames]})
      WHERE ci.tenant_id = ${tenantId}
        AND NOT EXISTS (
          SELECT 1 FROM inventory_balances ib
          WHERE ib.tenant_id = ci.tenant_id
            AND ib.product_id = ci.id
            AND ib.location_id = il.id
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `));
    return inserted.length;
  });
}
