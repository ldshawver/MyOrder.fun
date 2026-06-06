-- Repair production role/catalog state for CSR shift operations.

UPDATE "users"
SET
  "role" = 'customer_service_rep',
  "status" = 'approved',
  "is_active" = true,
  "updated_at" = now()
WHERE lower(trim(coalesce("first_name", '') || ' ' || coalesce("last_name", ''))) = 'adiken shawver';

UPDATE "catalog_items"
SET
  "is_local_alavont" = true,
  "is_woo_managed" = false,
  "merchant_product_source" = COALESCE(NULLIF("merchant_product_source", ''), 'local_mapped'),
  "merchant_processing_mode" = COALESCE(NULLIF("merchant_processing_mode", ''), 'mapped_lucifer')
WHERE COALESCE("is_woo_managed", false) = false
  AND (
    NULLIF("alavont_name", '') IS NOT NULL
    OR NULLIF("external_menu_id", '') IS NOT NULL
    OR "inventory_amount" IS NOT NULL
  );
