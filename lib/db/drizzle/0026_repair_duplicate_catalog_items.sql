-- Repair duplicate Product Master catalog rows.
-- Canonicalization is tenant-scoped and conservative:
--   1. SKU-bearing rows are grouped only by canonical SKU.
--   2. Normalized-name grouping is used only for rows with no SKU-like key.
-- This prevents same-name, different-SKU sellable Product Master rows from being merged.
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
WITH keyed AS (
  SELECT
    id,
    tenant_id,
    COALESCE(NULLIF(lower(trim(sku)), ''), NULLIF(lower(trim(alavont_id)), ''), NULLIF(lower(trim(merchant_sku)), '')) AS sku_key,
    regexp_replace(lower(trim(COALESCE(alavont_name, name))), '[^a-z0-9]+', ' ', 'g') AS name_key
  FROM catalog_items
), groups AS (
  SELECT id, tenant_id, 'sku'::text AS match_strategy, sku_key AS dedupe_key
  FROM keyed
  WHERE sku_key IS NOT NULL AND sku_key <> ''
  UNION ALL
  SELECT id, tenant_id, 'normalized_name_without_sku'::text AS match_strategy, name_key AS dedupe_key
  FROM keyed
  WHERE (sku_key IS NULL OR sku_key = '') AND name_key IS NOT NULL AND name_key <> ''
), ranked AS (
  SELECT
    id AS duplicate_id,
    min(id) OVER (PARTITION BY tenant_id, match_strategy, dedupe_key) AS canonical_id,
    match_strategy,
    dedupe_key,
    count(*) OVER (PARTITION BY tenant_id, match_strategy, dedupe_key) AS group_count
  FROM groups
)
SELECT duplicate_id, canonical_id, match_strategy, dedupe_key
FROM ranked
WHERE group_count > 1 AND duplicate_id <> canonical_id;

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

-- Move order and shift references; order history rows are retained.
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

-- Merge inventory balances by tenant/product/location, preserving total quantity and max PAR.
WITH moved AS (
  SELECT ib.*, m.canonical_id
  FROM inventory_balances ib
  JOIN catalog_item_duplicate_map m ON m.duplicate_id = ib.product_id
), upserted AS (
  UPDATE inventory_balances keep
  SET quantity_on_hand = keep.quantity_on_hand + moved.quantity_on_hand,
      par_level = GREATEST(keep.par_level, moved.par_level),
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
  AND NOT EXISTS (SELECT 1 FROM upserted u WHERE u.id = moved.id);

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
