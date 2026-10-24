import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Product = { id: number; tenantId: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; active: boolean };
export type InventoryStatus = "ready" | "missing_identity" | "missing_balance";
type Option = { id: number; productId: number; catalogItemId: number; inventoryItemId: number | null; inventoryCatalogItemId: number | null; label: string; optionValues: Record<string, string>; consumptionQuantity: string; sku: string | null; barcode: string | null; price: string; compareAtPrice: string | null; baseUnit: string | null; active: boolean; inventoryStatus: InventoryStatus; balanceRowCount: number; stockOnHand: string | null; reservedQuantity: string | null; availableQuantity: string | null; orderable: boolean };
export type SellableProduct = Product & { options: Option[] };

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

const SELLABLE_CATALOG_TABLES = [
  "catalogue_products",
  "catalogue_options",
  "inventory_items",
  "inventory_reorder_policies",
  "inventory_reservations",
] as const;
// inventory_reservations predates migration 0070. Its table and legacy
// columns are not evidence that optional catalogue enrichment was installed.
// These objects/columns are introduced by 0070 and therefore identify that
// feature independently of the older reservation table.
const SELLABLE_CATALOG_MARKER_TABLES = [
  "catalogue_products",
  "catalogue_options",
  "inventory_items",
  "inventory_reorder_policies",
] as const;
const SELLABLE_CATALOG_MARKER_COLUMNS = [
  ["inventory_reservations", "order_item_id"],
  ["order_items", "option_id"],
  ["order_items", "option_label_snapshot"],
  ["order_items", "sku_snapshot"],
  ["order_items", "inventory_item_id"],
  ["order_items", "inventory_quantity_snapshot"],
] as const;
const SELLABLE_CATALOG_COLUMNS = [
  ["catalogue_products", "id"],
  ["catalogue_products", "tenant_id"],
  ["catalogue_products", "name"],
  ["catalogue_products", "inventory_model"],
  ["catalogue_products", "location_evaluation"],
  ["catalogue_products", "active"],
  ["catalogue_options", "id"],
  ["catalogue_options", "tenant_id"],
  ["catalogue_options", "product_id"],
  ["catalogue_options", "catalog_item_id"],
  ["catalogue_options", "inventory_item_id"],
  ["catalogue_options", "label"],
  ["catalogue_options", "consumption_quantity"],
  ["catalogue_options", "sort_order"],
  ["catalogue_options", "active"],
  ["catalogue_options", "created_at"],
  ["catalogue_options", "updated_at"],
  ["inventory_items", "id"],
  ["inventory_items", "tenant_id"],
  ["inventory_items", "catalog_item_id"],
  ["inventory_items", "base_unit"],
  ["inventory_items", "created_at"],
  ["inventory_reorder_policies", "id"],
  ["inventory_reorder_policies", "tenant_id"],
  ["inventory_reorder_policies", "inventory_item_id"],
  ["inventory_reorder_policies", "location_id"],
  ["inventory_reorder_policies", "par"],
  ["inventory_reorder_policies", "reorder_point"],
  ["inventory_reorder_policies", "preferred_reorder_quantity"],
  ["inventory_reorder_policies", "moq"],
  ["inventory_reorder_policies", "updated_at"],
  ["inventory_reservations", "id"],
  ["inventory_reservations", "order_id"],
  ["inventory_reservations", "catalog_item_id"],
  ["inventory_reservations", "location_id"],
  ["inventory_reservations", "quantity"],
  ["inventory_reservations", "status"],
  ["inventory_reservations", "idempotency_key"],
  ["inventory_reservations", "expires_at"],
  ["inventory_reservations", "created_at"],
  ["inventory_reservations", "updated_at"],
  ["inventory_reservations", "order_item_id"],
  ["order_items", "option_id"],
  ["order_items", "option_label_snapshot"],
  ["order_items", "sku_snapshot"],
  ["order_items", "inventory_item_id"],
  ["order_items", "inventory_quantity_snapshot"],
] as const;

type SellableSchemaCapability = {
  presentTableCount: number | string;
  presentFeatureMarkerCount: number | string;
  presentColumnCount: number | string;
  missingColumnCount: number | string;
  presentIndexCount: number | string;
  presentFunctionCount: number | string;
  presentTriggerCount: number | string;
};

/**
 * Migration 0070 adds optional sellable-product enrichment to the catalog.
 * A wholly absent feature schema is supported; a partially installed schema
 * is an error and must not be silently treated as unsupported.
 */
export async function hasSellableProductSchema(): Promise<boolean> {
  const requiredColumns = sql.join(
    SELLABLE_CATALOG_COLUMNS.map(([tableName, columnName]) => sql`(${tableName}, ${columnName})`),
    sql`, `,
  );
  const featureMarkerColumns = sql.join(
    SELLABLE_CATALOG_MARKER_COLUMNS.map(([tableName, columnName]) => sql`(${tableName}, ${columnName})`),
    sql`, `,
  );
  const featureMarkerTables = sql.join(
    SELLABLE_CATALOG_MARKER_TABLES.map((tableName) => sql`(${tableName})`),
    sql`, `,
  );
  const result = await db.execute(sql`
    WITH required_columns(table_name, column_name) AS (VALUES ${requiredColumns}),
    feature_marker_columns(table_name, column_name) AS (VALUES ${featureMarkerColumns}),
    feature_marker_tables(table_name) AS (VALUES ${featureMarkerTables}),
    required_tables(table_name) AS (VALUES
      (${SELLABLE_CATALOG_TABLES[0]}),
      (${SELLABLE_CATALOG_TABLES[1]}),
      (${SELLABLE_CATALOG_TABLES[2]}),
      (${SELLABLE_CATALOG_TABLES[3]}),
      (${SELLABLE_CATALOG_TABLES[4]})
    )
    SELECT
      (SELECT count(*) FROM required_tables
       WHERE to_regclass('public.' || table_name) IS NOT NULL)::integer AS "presentTableCount",
      ((SELECT count(*) FROM feature_marker_tables
        WHERE to_regclass('public.' || table_name) IS NOT NULL)
       + (SELECT count(*) FROM feature_marker_columns marker
          WHERE EXISTS (
            SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.table_name = marker.table_name
              AND c.column_name = marker.column_name
          ))
       + (SELECT count(*) FROM unnest(ARRAY['catalogue_options_product_idx']::text[]) AS i(index_name)
          WHERE to_regclass('public.' || i.index_name) IS NOT NULL)
       + (SELECT count(*) FROM unnest(ARRAY[
            'block_live_inventory_model_change()', 'create_standard_option_for_catalogue_item()'
          ]::text[]) AS f(signature)
          WHERE to_regprocedure('public.' || f.signature) IS NOT NULL)
       + (SELECT count(*) FROM (VALUES
            ('catalog_items', 'catalog_item_standard_option'),
            ('catalogue_products', 'catalogue_product_inventory_model_guard')
          ) AS required_triggers(table_name, trigger_name)
          WHERE EXISTS (
            SELECT 1 FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = required_triggers.table_name
              AND t.tgname = required_triggers.trigger_name AND NOT t.tgisinternal
          )))::integer AS "presentFeatureMarkerCount",
      (SELECT count(*) FROM required_columns rc
       WHERE NOT EXISTS (
         SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name = rc.table_name
           AND c.column_name = rc.column_name
       ))::integer AS "missingColumnCount",
      (SELECT count(*) FROM required_columns rc
       WHERE EXISTS (
         SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name = rc.table_name
           AND c.column_name = rc.column_name
       ))::integer AS "presentColumnCount",
      (SELECT count(*) FROM unnest(ARRAY['catalogue_options_product_idx']::text[]) AS i(index_name)
       WHERE to_regclass('public.' || i.index_name) IS NOT NULL)::integer AS "presentIndexCount",
      (SELECT count(*) FROM unnest(ARRAY[
         'block_live_inventory_model_change()', 'create_standard_option_for_catalogue_item()'
       ]::text[]) AS f(signature)
       WHERE to_regprocedure('public.' || f.signature) IS NOT NULL)::integer AS "presentFunctionCount",
      (SELECT count(*) FROM (VALUES
         ('catalog_items', 'catalog_item_standard_option'),
         ('catalogue_products', 'catalogue_product_inventory_model_guard')
       ) AS required_triggers(table_name, trigger_name)
       WHERE EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = required_triggers.table_name
           AND t.tgname = required_triggers.trigger_name AND NOT t.tgisinternal
       ))::integer AS "presentTriggerCount"
  `);
  const capability = rows<SellableSchemaCapability>(result)[0];
  if (!capability) throw new Error("Could not inspect optional sellable catalogue schema");

  const presentTableCount = Number(capability.presentTableCount);
  const presentFeatureMarkerCount = Number(capability.presentFeatureMarkerCount);
  const missingColumnCount = Number(capability.missingColumnCount);
  const presentIndexCount = Number(capability.presentIndexCount);
  const presentFunctionCount = Number(capability.presentFunctionCount);
  const presentTriggerCount = Number(capability.presentTriggerCount);
  // A legacy inventory_reservations table is expected before 0070. Only
  // migration-specific objects and columns count as feature-presence markers.
  if (presentFeatureMarkerCount === 0) return false;
  const completeMigrationObjectCount =
    presentIndexCount === 1 && presentFunctionCount === 2 && presentTriggerCount === 2;
  if (presentTableCount !== SELLABLE_CATALOG_TABLES.length || missingColumnCount !== 0 || !completeMigrationObjectCount) {
    throw new Error("Optional sellable catalogue schema is incomplete");
  }
  return true;
}

/** The customer card and options endpoint use the same tenant-scoped option set. */
export async function loadSellableProducts(tenantId: number): Promise<SellableProduct[]> {
  const products = rows<Product>(await db.execute(sql`
    SELECT id, tenant_id AS "tenantId", name, inventory_model AS "inventoryModel",
      location_evaluation AS "locationEvaluation", active
    FROM catalogue_products WHERE tenant_id = ${tenantId} AND active = true ORDER BY id
  `));
  const options = rows<Option>(await db.execute(sql`
    WITH reserved_by_location AS (
      SELECT r.catalog_item_id, r.location_id, SUM(r.quantity)::numeric AS quantity
      FROM inventory_reservations r
      JOIN orders o ON o.id = r.order_id AND o.tenant_id = ${tenantId}
      WHERE r.status = 'reserved'
        AND (r.expires_at > now() OR EXISTS (
          SELECT 1 FROM payment_attempts p
          WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId}
            AND p.state IN ('creating','created','approved','capturing','reconciliation_required')
        ))
      GROUP BY r.catalog_item_id, r.location_id
    ), availability AS (
      SELECT ib.product_id,
        COUNT(*)::integer AS balance_row_count,
        SUM(ib.quantity_on_hand)::numeric AS stock_on_hand,
        SUM(COALESCE(r.quantity, 0))::numeric AS reserved_quantity,
        SUM(GREATEST(ib.quantity_on_hand - COALESCE(r.quantity, 0), 0))::numeric AS available_quantity,
        MAX(GREATEST(ib.quantity_on_hand - COALESCE(r.quantity, 0), 0))::numeric AS max_location_available
      FROM inventory_balances ib
      JOIN inventory_locations il ON il.tenant_id = ib.tenant_id AND il.id = ib.location_id AND il.is_active = true
      LEFT JOIN reserved_by_location r ON r.catalog_item_id = ib.product_id AND r.location_id = ib.location_id
      WHERE ib.tenant_id = ${tenantId} AND ib.inventory_kind = 'sellable_catalog'
        AND ib.is_sellable = true AND ib.quarantined_at IS NULL
      GROUP BY ib.product_id
    )
    SELECT co.id, co.product_id AS "productId", co.catalog_item_id AS "catalogItemId",
      co.inventory_item_id AS "inventoryItemId", ii.catalog_item_id AS "inventoryCatalogItemId",
      co.label, co.option_values AS "optionValues", co.consumption_quantity AS "consumptionQuantity", ci.sku, ci.barcode, ci.price, ci.compare_at_price AS "compareAtPrice",
      ii.base_unit AS "baseUnit", co.active,
      CASE WHEN ii.id IS NULL THEN 'missing_identity'
        WHEN COALESCE(a.balance_row_count, 0) = 0 THEN 'missing_balance'
        ELSE 'ready' END AS "inventoryStatus",
      COALESCE(a.balance_row_count, 0)::integer AS "balanceRowCount",
      CASE WHEN a.balance_row_count > 0 THEN a.stock_on_hand::text ELSE NULL END AS "stockOnHand",
      CASE WHEN a.balance_row_count > 0 THEN a.reserved_quantity::text ELSE NULL END AS "reservedQuantity",
      CASE WHEN a.balance_row_count > 0 THEN a.available_quantity::text ELSE NULL END AS "availableQuantity",
      CASE WHEN ii.id IS NULL OR COALESCE(a.balance_row_count, 0) = 0 THEN false
        WHEN cp.location_evaluation = 'PER_LOCATION' THEN a.max_location_available >= co.consumption_quantity
        ELSE a.available_quantity >= co.consumption_quantity END AS orderable
    FROM catalogue_options co
    JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
    LEFT JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
    LEFT JOIN availability a ON a.product_id = ii.catalog_item_id
    JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
    WHERE co.tenant_id = ${tenantId} AND co.active = true AND ci.is_available = true
      AND ci.alavont_in_stock IS DISTINCT FROM false
      AND COALESCE((ci.metadata->>'isVisible')::boolean, true) = true
      AND COALESCE((ci.metadata->>'archived')::boolean, false) = false
      AND COALESCE((ci.metadata->>'safeOnlyDuplicate')::boolean, false) = false
      AND COALESCE((ci.metadata->>'complianceHold')::boolean, false) = false
      AND ci.metadata->>'mergedIntoCatalogItemId' IS NULL
    ORDER BY co.product_id, co.sort_order, co.id
  `));
  const byProduct = new Map<number, Option[]>();
  for (const option of options) byProduct.set(option.productId, [...(byProduct.get(option.productId) ?? []), option]);
  return products.map(product => ({ ...product, options: byProduct.get(product.id) ?? [] }))
    .filter(product => product.options.length > 0);
}
