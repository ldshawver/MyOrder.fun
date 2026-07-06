import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const POS_INTEGRITY_STRICT = process.env.POS_INTEGRITY_STRICT === "true";

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []);
}

type OrphanInventoryRow = { inventoryBalanceId: number; tenantId: number; productId: number; locationId: number };
type MissingInventory = { tenantId: number; catalogItemId: number; locationId: number; locationName: string | null };
type InvalidCheckoutMapping = { source: string; referenceId: number; catalogItemId: number };
type InventoryMismatchLocation = { tenantId: number; productId: number; locationId: number; rowCount: number };

export type PosIntegrityReport = {
  duplicateCatalogItemsCount: number;
  orphanInventoryRows: OrphanInventoryRow[];
  missingInventoryByCatalogId: MissingInventory[];
  invalidCheckoutMappings: InvalidCheckoutMapping[];
  inventoryMismatchLocations: InventoryMismatchLocation[];
  lastRepairRunHash: string;
};

export class PosIntegrityError extends Error {
  constructor(public readonly status: number, message: string, public readonly report: PosIntegrityReport) {
    super(message);
  }
}

export async function collectPosIntegrityReport(tenantId: number | null = null): Promise<PosIntegrityReport> {
  const tenantFilter = sql`${tenantId}::int IS NULL OR ci.tenant_id = ${tenantId}::int`;
  const orphanInventoryRows = rowsFrom<OrphanInventoryRow>(await db.execute(sql`
    SELECT ib.id AS "inventoryBalanceId", ib.tenant_id AS "tenantId", ib.product_id AS "productId", ib.location_id AS "locationId"
    FROM inventory_balances ib
    LEFT JOIN catalog_items ci ON ci.id = ib.product_id AND ci.tenant_id = ib.tenant_id
    WHERE ci.id IS NULL AND (${tenantId}::int IS NULL OR ib.tenant_id = ${tenantId}::int)
    ORDER BY ib.tenant_id, ib.product_id, ib.location_id, ib.id
  `));

  const inventoryMismatchLocations = rowsFrom<InventoryMismatchLocation>(await db.execute(sql`
    SELECT tenant_id AS "tenantId", product_id AS "productId", location_id AS "locationId", count(*)::int AS "rowCount"
    FROM inventory_balances
    WHERE (${tenantId}::int IS NULL OR tenant_id = ${tenantId}::int)
    GROUP BY tenant_id, product_id, location_id
    HAVING count(*) > 1
    ORDER BY tenant_id, product_id, location_id
  `));

  const missingInventoryByCatalogId = rowsFrom<MissingInventory>(await db.execute(sql`
    SELECT ci.tenant_id AS "tenantId", ci.id AS "catalogItemId", il.id AS "locationId", il.name AS "locationName"
    FROM catalog_items ci
    JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.is_active = true
    LEFT JOIN inventory_balances ib ON ib.tenant_id = ci.tenant_id AND ib.product_id = ci.id AND ib.location_id = il.id
    WHERE (${tenantFilter})
      AND coalesce(ci.is_available, true) = true
      AND coalesce(ci.is_woo_managed, false) = false
      AND coalesce(ci.is_local_alavont, true) = true
      AND coalesce((ci.metadata->>'archived')::boolean, false) = false
      AND ib.id IS NULL
    ORDER BY ci.tenant_id, ci.id, il.display_order, il.id
  `));

  const invalidCheckoutMappings = rowsFrom<InvalidCheckoutMapping>(await db.execute(sql`
    SELECT 'order_items' AS source, oi.id AS "referenceId", oi.catalog_item_id AS "catalogItemId"
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN catalog_items ci ON ci.id = oi.catalog_item_id
    WHERE ci.id IS NULL AND (${tenantId}::int IS NULL OR o.tenant_id = ${tenantId}::int)
    UNION ALL
    SELECT 'shift_inventory_items' AS source, sii.id AS "referenceId", sii.catalog_item_id AS "catalogItemId"
    FROM shift_inventory_items sii
    JOIN lab_tech_shifts lts ON lts.id = sii.shift_id
    LEFT JOIN catalog_items ci ON ci.id = sii.catalog_item_id
    WHERE sii.catalog_item_id IS NOT NULL AND ci.id IS NULL AND (${tenantId}::int IS NULL OR lts.tenant_id = ${tenantId}::int)
    UNION ALL
    SELECT 'inventory_templates' AS source, it.id AS "referenceId", it.catalog_item_id AS "catalogItemId"
    FROM inventory_templates it
    LEFT JOIN catalog_items ci ON ci.id = it.catalog_item_id
    WHERE it.catalog_item_id IS NOT NULL AND ci.id IS NULL AND (${tenantId}::int IS NULL OR it.tenant_id = ${tenantId}::int)
    ORDER BY source, "referenceId"
  `));

  const duplicateRows = rowsFrom<{ catalogItemId: number }>(await db.execute(sql`
    WITH keys AS (
      SELECT ci.id, ci.tenant_id, 'name' AS key_type, lower(regexp_replace(trim(ci.name), '[^a-zA-Z0-9]+', ' ', 'g')) AS key_value
      FROM catalog_items ci WHERE (${tenantFilter}) AND nullif(trim(ci.name), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'sku', lower(regexp_replace(trim(ci.sku), '[^a-zA-Z0-9]+', ' ', 'g'))
      FROM catalog_items ci WHERE (${tenantFilter}) AND nullif(trim(ci.sku), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'merchant_sku', lower(regexp_replace(trim(ci.merchant_sku), '[^a-zA-Z0-9]+', ' ', 'g'))
      FROM catalog_items ci WHERE (${tenantFilter}) AND nullif(trim(ci.merchant_sku), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'alavont_id', lower(regexp_replace(trim(ci.alavont_id), '[^a-zA-Z0-9]+', ' ', 'g'))
      FROM catalog_items ci WHERE (${tenantFilter}) AND nullif(trim(ci.alavont_id), '') IS NOT NULL
    ), duplicate_keys AS (
      SELECT tenant_id, key_type, key_value FROM keys GROUP BY tenant_id, key_type, key_value HAVING count(*) > 1
    )
    SELECT DISTINCT k.id AS "catalogItemId"
    FROM keys k
    JOIN duplicate_keys dk ON dk.tenant_id = k.tenant_id AND dk.key_type = k.key_type AND dk.key_value = k.key_value
  `));

  const reportWithoutHash = {
    duplicateCatalogItemsCount: duplicateRows.length,
    orphanInventoryRows,
    missingInventoryByCatalogId,
    invalidCheckoutMappings,
    inventoryMismatchLocations,
  };
  const lastRepairRunHash = crypto.createHash("sha256").update(JSON.stringify(reportWithoutHash)).digest("hex");
  return { ...reportWithoutHash, lastRepairRunHash };
}

export function assertPosIntegrityReport(report: PosIntegrityReport): void {
  if (!POS_INTEGRITY_STRICT) return;
  if (report.missingInventoryByCatalogId.length > 0) {
    const first = report.missingInventoryByCatalogId[0]!;
    throw new PosIntegrityError(409, `Missing inventory row for catalogItemId ${first.catalogItemId} at locationId ${first.locationId}`, report);
  }
  if (report.duplicateCatalogItemsCount > 0 || report.inventoryMismatchLocations.length > 0 || report.orphanInventoryRows.length > 0 || report.invalidCheckoutMappings.length > 0) {
    throw new PosIntegrityError(500, "POS integrity invariant failed", report);
  }
}
