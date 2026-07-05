import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const confirm = process.argv.includes("--confirm");
const tenantArg = process.argv.find(arg => arg.startsWith("--tenant-id="));
const tenantId = tenantArg ? Number(tenantArg.split("=")[1]) : null;
if (tenantArg && (!Number.isInteger(tenantId) || tenantId! <= 0)) throw new Error("--tenant-id must be a positive integer");

type Candidate = {
  duplicateCatalogItemId: number;
  canonicalCatalogItemId: number;
  duplicateName: string | null;
  canonicalName: string | null;
  reason: string;
  inventoryRows: number;
  orderItemRefs: number;
};

const rows = (await db.execute(sql`
WITH catalog_stats AS (
  SELECT
    ci.id,
    ci.tenant_id,
    ci.name,
    ci.safe_name,
    ci.sku,
    ci.merchant_sku,
    ci.alavont_id,
    lower(regexp_replace(coalesce(nullif(ci.sku, ''), nullif(ci.merchant_sku, ''), nullif(ci.alavont_id, ''), ci.name, ci.safe_name, ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS sku_key,
    lower(regexp_replace(coalesce(nullif(ci.name, ''), nullif(ci.safe_name, ''), ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS name_key,
    lower(regexp_replace(coalesce(nullif(ci.safe_name, ''), nullif(ci.name, ''), ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS safe_key,
    (SELECT count(*)::int FROM inventory_balances ib WHERE ib.tenant_id = ci.tenant_id AND ib.product_id = ci.id) AS inventory_rows,
    (SELECT count(*)::int FROM order_items oi WHERE oi.catalog_item_id = ci.id) AS order_item_refs
  FROM catalog_items ci
  WHERE (${tenantId}::int IS NULL OR ci.tenant_id = ${tenantId}::int)
), grouped AS (
  SELECT a.*, b.id AS other_id, b.name AS other_name, b.inventory_rows AS other_inventory_rows, b.order_item_refs AS other_order_item_refs
  FROM catalog_stats a
  JOIN catalog_stats b ON a.tenant_id = b.tenant_id AND a.id <> b.id
   AND (a.sku_key <> '' AND a.sku_key = b.sku_key OR a.name_key <> '' AND a.name_key = b.name_key OR a.safe_key <> '' AND a.safe_key = b.safe_key)
  WHERE ((a.inventory_rows = 0 AND b.inventory_rows > 0) OR (a.inventory_rows > 0 AND b.inventory_rows = 0))
), ranked AS (
  SELECT *,
    CASE
      WHEN inventory_rows > other_inventory_rows THEN id
      WHEN inventory_rows < other_inventory_rows THEN other_id
      WHEN order_item_refs > other_order_item_refs THEN id
      WHEN order_item_refs < other_order_item_refs THEN other_id
      ELSE LEAST(id, other_id)
    END AS canonical_id
  FROM grouped
)
SELECT DISTINCT
  CASE WHEN id = canonical_id THEN other_id ELSE id END AS "duplicateCatalogItemId",
  canonical_id AS "canonicalCatalogItemId",
  CASE WHEN id = canonical_id THEN other_name ELSE name END AS "duplicateName",
  CASE WHEN id = canonical_id THEN name ELSE other_name END AS "canonicalName",
  'same tenant and normalized sku/name/safe_name; canonical prefers inventory, order refs, oldest id' AS reason,
  CASE WHEN id = canonical_id THEN other_inventory_rows ELSE inventory_rows END AS "inventoryRows",
  CASE WHEN id = canonical_id THEN other_order_item_refs ELSE order_item_refs END AS "orderItemRefs"
FROM ranked
WHERE (CASE WHEN id = canonical_id THEN other_inventory_rows ELSE inventory_rows END) = 0
ORDER BY "canonicalCatalogItemId", "duplicateCatalogItemId"
`)) as unknown as { rows?: Candidate[] } | Candidate[];

const candidates = Array.isArray(rows) ? rows : rows.rows ?? [];
console.log(JSON.stringify({ dryRun: !confirm, count: candidates.length, repairs: candidates }, null, 2));

if (!confirm || candidates.length === 0) process.exit(0);

await db.transaction(async tx => {
  for (const c of candidates) {
    await tx.execute(sql`UPDATE order_items SET catalog_item_id = ${c.canonicalCatalogItemId} WHERE catalog_item_id = ${c.duplicateCatalogItemId}`);
    await tx.execute(sql`UPDATE inventory_templates SET catalog_item_id = ${c.canonicalCatalogItemId} WHERE catalog_item_id = ${c.duplicateCatalogItemId}`);
    await tx.execute(sql`UPDATE print_jobs SET payload_json = jsonb_set(payload_json, '{repairedDuplicateCatalogItemId}', to_jsonb(${c.duplicateCatalogItemId}::int), true) WHERE payload_json::text LIKE ${`%${c.duplicateCatalogItemId}%`}`);
    await tx.execute(sql`DELETE FROM catalog_items ci WHERE ci.id = ${c.duplicateCatalogItemId} AND NOT EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.product_id = ci.id)`);
    await tx.execute(sql`INSERT INTO audit_logs (action, resource_type, resource_id, metadata, created_at) VALUES ('REPAIR_DUPLICATE_SAFE_PRODUCT', 'catalog_item', ${String(c.duplicateCatalogItemId)}, ${JSON.stringify(c)}::jsonb, now())`);
  }
});
