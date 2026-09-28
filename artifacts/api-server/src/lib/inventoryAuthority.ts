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
  tenantId: number,
  productId: number,
  locationId: number,
  ignoreReservationIds: number[] = [],
): Promise<string> {
  const ignoreSql = ignoreReservationIds.length > 0
    ? sql`AND r.id <> ALL(ARRAY[${sql.join(ignoreReservationIds, sql`, `)}]::int[])`
    : sql``;
  const row = rowsFrom<ReservationSumRow>(await executor.execute(sql`
    SELECT COALESCE(SUM(quantity), 0)::numeric AS "reservedQuantity"
    FROM inventory_reservations r
    JOIN orders o ON o.id = r.order_id AND o.tenant_id = ${tenantId}
    WHERE r.catalog_item_id = ${productId}
      AND r.location_id = ${locationId}
      AND r.status = 'reserved'
      AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))
      ${ignoreSql}
  `))[0];
  return String(row?.reservedQuantity ?? "0");
}

export async function assertInventoryBalanceWriteSafe(
  executor: AuthorityExecutor,
  params: { tenantId: number; productId: number; locationId: number; nextQuantityOnHand: string | number; context: string; ignoreReservationIds?: number[] },
): Promise<void> {
  const activeReserved = await getActiveReservedQuantity(executor, params.tenantId, params.productId, params.locationId, params.ignoreReservationIds ?? []);
  const unsafe = rowsFrom<{ unsafe: boolean }>(await executor.execute(sql`SELECT ${String(params.nextQuantityOnHand)}::numeric < ${activeReserved}::numeric AS unsafe`))[0]?.unsafe;
  if (unsafe) {
    const message = `DIRECT INVENTORY WRITE BLOCKED — USE inventoryAuthority: productId ${params.productId} locationId ${params.locationId} next quantity ${params.nextQuantityOnHand} is below active reservations ${activeReserved}`;
    logger.error({ ...params, activeReserved, strict: POS_INVENTORY_STRICT_MODE }, message);
    throw new Error(message);
  }
}

export async function collectInventoryReconcileReport(tenantId: number): Promise<{
  orphanReservations: OrphanReservationRow[];
  negativeAvailability: NegativeAvailabilityRow[];
  mismatchedDeductions: MismatchedDeductionRow[];
  expiredReservations: number;
}> {
  const expiredReservations = Number(rowsFrom<{ count: unknown }>(await db.execute(sql`
    SELECT count(*)::int AS count
    FROM inventory_reservations
    WHERE status = 'reserved' AND expires_at <= now()
      AND order_id IN (SELECT id FROM orders WHERE tenant_id = ${tenantId})
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
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id AND ci.tenant_id = ${tenantId}
    LEFT JOIN inventory_locations il ON il.id = r.location_id AND il.tenant_id = ${tenantId}
    WHERE r.status = 'reserved'
      AND o.tenant_id = ${tenantId}
      AND r.expires_at > now()
      AND (o.id IS NULL OR ci.id IS NULL OR il.id IS NULL)
  `));

  const negativeAvailability = rowsFrom<NegativeAvailabilityRow>(await db.execute(sql`
    SELECT ib.product_id AS "productId", ib.location_id AS "locationId", ib.quantity_on_hand AS "quantityOnHand",
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))), 0) AS "activeReserved",
      ib.quantity_on_hand - COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))), 0) AS "available"
    FROM inventory_balances ib
    LEFT JOIN inventory_reservations r ON r.catalog_item_id = ib.product_id AND r.location_id = ib.location_id
    WHERE ib.tenant_id = ${tenantId}
    GROUP BY ib.product_id, ib.location_id, ib.quantity_on_hand
    HAVING ib.quantity_on_hand < COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required')))), 0)
  `));

  const mismatchedDeductions = rowsFrom<MismatchedDeductionRow>(await db.execute(sql`
    SELECT r.id AS "reservationId", r.order_id AS "orderId", r.catalog_item_id AS "catalogItemId", r.location_id AS "locationId", r.quantity::int AS "quantity"
    FROM inventory_reservations r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN order_items oi ON oi.order_id = r.order_id AND oi.catalog_item_id = r.catalog_item_id
    WHERE r.status = 'confirmed' AND o.tenant_id = ${tenantId}
      AND (oi.id IS NULL OR oi.inventory_deductions IS NULL OR oi.inventory_deductions = '[]'::jsonb)
  `));

  return { orphanReservations, negativeAvailability, mismatchedDeductions, expiredReservations };
}

export async function reconcileInventoryState(tenantId: number): Promise<Awaited<ReturnType<typeof collectInventoryReconcileReport>> & { releasedExpiredReservations: number; releasedOrphanReservations: number }> {
  const report = await collectInventoryReconcileReport(tenantId);
  const releasedExpiredReservations = await executeTransaction(tenantId, "inventoryAuthority.reconcile.releaseExpired", async tx => rowsFrom<{ id: number }>(await tx.execute(sql`
    UPDATE inventory_reservations
    SET status = 'released', updated_at = now()
    WHERE status = 'reserved' AND expires_at <= now()
      AND order_id IN (SELECT id FROM orders WHERE tenant_id = ${tenantId})
      AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = inventory_reservations.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required'))
    RETURNING id
  `)).length);
  const orphanIds = report.orphanReservations.map(row => row.reservationId);
  let releasedOrphanReservations = 0;
  if (orphanIds.length > 0) {
    releasedOrphanReservations = await executeTransaction(tenantId, "inventoryAuthority.reconcile.releaseOrphans", async tx => rowsFrom<{ id: number }>(await tx.execute(sql`
      UPDATE inventory_reservations
      SET status = 'released', updated_at = now()
      WHERE id = ANY(ARRAY[${sql.join(orphanIds, sql`, `)}]::int[]) AND status = 'reserved'
        AND order_id IN (SELECT id FROM orders WHERE tenant_id = ${tenantId})
        AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = inventory_reservations.order_id AND p.tenant_id = ${tenantId} AND p.state IN ('creating','created','approved','capturing','reconciliation_required'))
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
  params: { tenantId: number; productId: number; locationId: number; quantityOnHand: string | number; parLevel: string | number; context: string },
): Promise<void> {
  await executeTransaction(params.tenantId, executor, params.context, async tx => {
    const identity = rowsFrom<{ valid: boolean }>(await tx.execute(sql`
      SELECT EXISTS (SELECT 1 FROM catalog_items WHERE tenant_id = ${params.tenantId} AND id = ${params.productId})
        AND EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${params.tenantId} AND id = ${params.locationId}) AS valid`))[0];
    if (!identity?.valid) throw new Error("Inventory product or location is not in the authorized tenant");
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
      tenantId: params.tenantId,
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
  params: { tenantId: number; productId: number; locationId: number; quantity: string | number; context: string; ignoreReservationIds?: number[] },
): Promise<{ remainingStock: number } | null> {
  return executeTransaction(params.tenantId, executor, params.context, async tx => {
    const current = rowsFrom<{ id: number; quantityOnHand: unknown }>(await tx.execute(sql`
      SELECT id, quantity_on_hand AS "quantityOnHand"
      FROM inventory_balances
      WHERE tenant_id = ${params.tenantId} AND product_id = ${params.productId} AND location_id = ${params.locationId}
      LIMIT 1
      FOR UPDATE
    `))[0];
    if (!current) return null;
    const nextQuantityOnHand = rowsFrom<{ next: string }>(await tx.execute(sql`SELECT ${String(current.quantityOnHand ?? 0)}::numeric - ${String(params.quantity)}::numeric AS next`))[0]?.next ?? "0";
    await assertInventoryBalanceWriteSafe(tx, {
      tenantId: params.tenantId,
      productId: params.productId,
      locationId: params.locationId,
      nextQuantityOnHand,
      context: params.context,
      ignoreReservationIds: params.ignoreReservationIds,
    });
    const updated = rowsFrom<{ quantityOnHand: unknown }>(await tx.execute(sql`
      UPDATE inventory_balances
      SET quantity_on_hand = quantity_on_hand - ${String(params.quantity)}, updated_at = now()
      WHERE tenant_id = ${params.tenantId} AND id = ${current.id}
        AND quantity_on_hand >= ${String(params.quantity)}
      RETURNING quantity_on_hand AS "quantityOnHand"
    `))[0];
    return updated ? { remainingStock: Number(updated.quantityOnHand ?? 0) } : null;
  });
}

export async function bootstrapMissingInventoryBalancesThroughAuthority(tenantId: number, requiredLocationNames: readonly string[]): Promise<number> {
  return executeTransaction(tenantId, "inventoryAuthority.bootstrapMissingInventoryBalances", async tx => {
    const inserted = rowsFrom<{ id: number }>(await tx.execute(sql`
      INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
      SELECT ${tenantId}, ci.id, il.id, 0, 0, 'sellable_catalog', true, now()
      FROM catalog_items ci
      JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.name = ANY(ARRAY[${sql.join([...requiredLocationNames], sql`, `)}]::text[])
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

/** Explicit physical restock. A refund never invokes this primitive automatically. */
export async function restoreInventoryBalanceThroughAuthority(
  executor: AuthorityExecutor,
  params: { tenantId: number; productId: number; locationId: number; quantity: string; idempotencyKey: string; reason: string },
): Promise<{ restored: boolean; quantityOnHand: string }> {
  if (!/^\d{1,14}(?:\.\d{1,6})?$/.test(params.quantity) || /^0+(?:\.0+)?$/.test(params.quantity)) throw new Error("Invalid restoration quantity");
  if (!params.idempotencyKey || !params.reason.trim()) throw new Error("Restoration requires an idempotency key and reason");
  return executeTransaction(params.tenantId, executor, "inventoryAuthority.restore", async tx => {
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS inventory_restorations (
      id bigserial PRIMARY KEY, tenant_id integer NOT NULL, product_id integer NOT NULL,
      location_id integer NOT NULL, quantity numeric(20, 6) NOT NULL,
      idempotency_key text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idempotency_key))`);
    const inserted = rowsFrom<{ id: number }>(await tx.execute(sql`
      INSERT INTO inventory_restorations (tenant_id, product_id, location_id, quantity, idempotency_key, reason)
      SELECT ${params.tenantId}, ${params.productId}, ${params.locationId}, ${params.quantity}::numeric, ${params.idempotencyKey}, ${params.reason}
      WHERE EXISTS (SELECT 1 FROM catalog_items WHERE tenant_id = ${params.tenantId} AND id = ${params.productId})
        AND EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${params.tenantId} AND id = ${params.locationId})
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`));
    const existing = rowsFrom<{ productId: number; locationId: number; quantityMatches: boolean }>(await tx.execute(sql`
      SELECT product_id AS "productId", location_id AS "locationId", quantity = ${params.quantity}::numeric AS "quantityMatches" FROM inventory_restorations
      WHERE tenant_id = ${params.tenantId} AND idempotency_key = ${params.idempotencyKey}`))[0];
    if (!existing || existing.productId !== params.productId || existing.locationId !== params.locationId || !existing.quantityMatches) throw new Error("Restoration identity conflict or foreign inventory object");
    if (inserted.length) {
      const updated = rowsFrom<{ quantityOnHand: string }>(await tx.execute(sql`
        UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand + ${params.quantity}::numeric, updated_at = now()
        WHERE tenant_id = ${params.tenantId} AND product_id = ${params.productId} AND location_id = ${params.locationId}
          AND inventory_kind = 'sellable_catalog' AND is_sellable = true AND quarantined_at IS NULL
        RETURNING quantity_on_hand AS "quantityOnHand"`))[0];
      if (!updated) throw new Error("Sellable inventory balance was not found");
      return { restored: true, quantityOnHand: updated.quantityOnHand };
    }
    const balance = rowsFrom<{ quantityOnHand: string }>(await tx.execute(sql`SELECT quantity_on_hand AS "quantityOnHand" FROM inventory_balances WHERE tenant_id = ${params.tenantId} AND product_id = ${params.productId} AND location_id = ${params.locationId}`))[0];
    if (!balance) throw new Error("Inventory balance was not found");
    return { restored: false, quantityOnHand: balance.quantityOnHand };
  });
}
