import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Product = { id: number; tenantId: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; active: boolean };
type Option = { id: number; productId: number; catalogItemId: number; inventoryItemId: number; inventoryCatalogItemId: number; label: string; optionValues: Record<string, string>; consumptionQuantity: string; sku: string | null; barcode: string | null; imageUrl: string | null; price: string; compareAtPrice: string | null; baseUnit: string; active: boolean; stockAvailable: boolean };
export type SellableProduct = Product & { options: Option[] };

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

/** The customer card and options endpoint use the same tenant-scoped option set. */
export async function loadSellableProducts(tenantId: number): Promise<SellableProduct[]> {
  const products = rows<Product>(await db.execute(sql`
    SELECT id, tenant_id AS "tenantId", name, inventory_model AS "inventoryModel",
      location_evaluation AS "locationEvaluation", active
    FROM catalogue_products WHERE tenant_id = ${tenantId} AND active = true ORDER BY id
  `));
  const options = rows<Option>(await db.execute(sql`
    SELECT co.id, co.product_id AS "productId", co.catalog_item_id AS "catalogItemId",
      co.inventory_item_id AS "inventoryItemId", ii.catalog_item_id AS "inventoryCatalogItemId",
      co.label, co.option_values AS "optionValues", co.consumption_quantity AS "consumptionQuantity", ci.sku, ci.barcode, ci.image_url AS "imageUrl", ci.price, ci.compare_at_price AS "compareAtPrice",
      ii.base_unit AS "baseUnit", co.active,
      (COALESCE((
        SELECT SUM(ib.quantity_on_hand - COALESCE((
          SELECT SUM(r.quantity) FROM inventory_reservations r
          JOIN orders ro ON ro.id = r.order_id AND ro.tenant_id = ${tenantId}
          WHERE r.catalog_item_id = ii.catalog_item_id AND r.location_id = ib.location_id
            AND r.status = 'reserved' AND (r.expires_at > now() OR EXISTS (
              SELECT 1 FROM payment_attempts pa WHERE pa.order_id = ro.id AND pa.tenant_id = ${tenantId}
                AND pa.state IN ('creating','created','approved','capturing','reconciliation_required')
            ))
        ), 0))
        FROM inventory_balances ib JOIN inventory_locations il ON il.tenant_id = ib.tenant_id AND il.id = ib.location_id
        WHERE ib.tenant_id = co.tenant_id AND ib.product_id = ii.catalog_item_id
          AND ib.inventory_kind = 'sellable_catalog' AND ib.is_sellable = true AND ib.quarantined_at IS NULL
          AND il.is_active = true AND (cp.location_evaluation = 'COMBINED_LOCATIONS' OR il.id = COALESCE((SELECT default_inventory_location_id FROM tenant_settings WHERE tenant_id = ${tenantId} LIMIT 1), -1))
      ), 0) >= co.consumption_quantity AND (cp.location_evaluation = 'COMBINED_LOCATIONS' OR EXISTS (
        SELECT 1 FROM tenant_settings ts JOIN inventory_locations dl ON dl.tenant_id = ts.tenant_id AND dl.id = ts.default_inventory_location_id AND dl.is_active = true
        WHERE ts.tenant_id = ${tenantId}
      ))) AS "stockAvailable"
    FROM catalogue_options co
    JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
    JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
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
