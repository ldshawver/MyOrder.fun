-- Repair duplicate Product Master catalog rows by normalized product name.
--
-- Canonical choice per tenant + lower(trim(name)) prefers rows that are already
-- referenced by real POS history/state, in this order:
--   1. any order_items.catalog_item_id reference
--   2. any shift_inventory_items.catalog_item_id reference
--   3. any inventory_balances.product_id reference
--   4. lowest catalog_items.id
--
-- References are moved before duplicate catalog_items are deleted. Duplicate row
-- JSON is archived in catalog_item_duplicate_repair_archive before mutation.
--
-- Verification SQL after migration:
--   SELECT tenant_id, lower(trim(name)) AS normalized_name, array_agg(id ORDER BY id) AS ids, count(*)
--   FROM catalog_items
--   GROUP BY tenant_id, lower(trim(name))
--   HAVING count(*) > 1;
-- Expected: 0 rows.
--
-- Rollback notes:
--   This migration is intentionally data-repairing, not automatically reversible.
--   To manually restore a deleted duplicate, insert duplicate_row from
--   catalog_item_duplicate_repair_archive back into catalog_items, then move any
--   desired references from canonical_catalog_item_id back to duplicate_catalog_item_id.
--   Because order and inventory references may have changed after deployment, a
--   blind automated rollback could corrupt live POS history/state.
BEGIN;

CREATE TABLE IF NOT EXISTS catalog_item_duplicate_repair_archive (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  canonical_catalog_item_id integer NOT NULL REFERENCES catalog_items(id),
  duplicate_catalog_item_id integer NOT NULL,
  match_strategy text NOT NULL,
  match_key text NOT NULL,
  duplicate_row jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (duplicate_catalog_item_id)
);

DROP TABLE IF EXISTS catalog_item_duplicate_map;
CREATE TEMP TABLE catalog_item_duplicate_map AS
WITH usage AS (
  SELECT
    ci.id,
    ci.tenant_id,
    lower(trim(ci.name)) AS normalized_name,
    EXISTS (SELECT 1 FROM order_items oi WHERE oi.catalog_item_id = ci.id) AS has_order_items,
    EXISTS (SELECT 1 FROM shift_inventory_items sii WHERE sii.catalog_item_id = ci.id) AS has_shift_inventory_items,
    EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.product_id = ci.id) AS has_inventory_balances
  FROM catalog_items ci
  WHERE NULLIF(lower(trim(ci.name)), '') IS NOT NULL
), ranked AS (
  SELECT
    id,
    tenant_id,
    normalized_name,
    first_value(id) OVER (
      PARTITION BY tenant_id, normalized_name
      ORDER BY
        has_order_items DESC,
        has_shift_inventory_items DESC,
        has_inventory_balances DESC,
        id ASC
    ) AS canonical_id,
    count(*) OVER (PARTITION BY tenant_id, normalized_name) AS group_count
  FROM usage
)
SELECT
  id AS duplicate_id,
  canonical_id,
  'lower_trim_name'::text AS match_strategy,
  normalized_name AS dedupe_key
FROM ranked
WHERE group_count > 1 AND id <> canonical_id;

-- Archive duplicate catalog rows before any reference movement/deletion.
INSERT INTO catalog_item_duplicate_repair_archive (
  tenant_id,
  canonical_catalog_item_id,
  duplicate_catalog_item_id,
  match_strategy,
  match_key,
  duplicate_row
)
SELECT
  dup.tenant_id,
  m.canonical_id,
  m.duplicate_id,
  m.match_strategy,
  m.dedupe_key,
  to_jsonb(dup)
FROM catalog_item_duplicate_map m
JOIN catalog_items dup ON dup.id = m.duplicate_id
ON CONFLICT (duplicate_catalog_item_id) DO NOTHING;

-- Move order and shift/template references; order history rows are retained.
UPDATE order_items oi
SET catalog_item_id = m.canonical_id
FROM catalog_item_duplicate_map m
WHERE oi.catalog_item_id = m.duplicate_id;

UPDATE inventory_templates it
SET catalog_item_id = m.canonical_id
FROM catalog_item_duplicate_map m
WHERE it.catalog_item_id = m.duplicate_id;

UPDATE shift_inventory_items sii
SET catalog_item_id = m.canonical_id
FROM catalog_item_duplicate_map m
WHERE sii.catalog_item_id = m.duplicate_id;

-- Merge duplicate inventory balances into canonical product by tenant/location.
-- Quantity is summed to preserve inventory. PAR uses greatest non-null PAR.
WITH moved AS (
  SELECT ib.*, m.canonical_id
  FROM inventory_balances ib
  JOIN catalog_item_duplicate_map m ON m.duplicate_id = ib.product_id
), merged AS (
  UPDATE inventory_balances keep
  SET quantity_on_hand = COALESCE(keep.quantity_on_hand, 0) + COALESCE(moved.quantity_on_hand, 0),
      par_level = GREATEST(COALESCE(keep.par_level, 0), COALESCE(moved.par_level, 0)),
      updated_at = now()
  FROM moved
  WHERE keep.tenant_id = moved.tenant_id
    AND keep.product_id = moved.canonical_id
    AND keep.location_id = moved.location_id
  RETURNING moved.id
)
UPDATE inventory_balances ib
SET product_id = moved.canonical_id,
    updated_at = now()
FROM moved
WHERE ib.id = moved.id
  AND NOT EXISTS (SELECT 1 FROM merged m WHERE m.id = moved.id);

DELETE FROM inventory_balances ib
USING catalog_item_duplicate_map m
WHERE ib.product_id = m.duplicate_id;

-- Best-effort print job JSON rewrite for common payload shapes containing catalog item ids.
UPDATE print_jobs pj
SET payload_json = replace(pj.payload_json::text, '"catalogItemId":'||m.duplicate_id, '"catalogItemId":'||m.canonical_id)::jsonb
FROM catalog_item_duplicate_map m
WHERE pj.payload_json::text LIKE '%"catalogItemId":'||m.duplicate_id||'%';

DELETE FROM catalog_items ci
USING catalog_item_duplicate_map m
WHERE ci.id = m.duplicate_id;

COMMIT;
