ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "safe_name" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "safe_description" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "safe_category" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "safe_image_url" text;

UPDATE "catalog_items"
SET
  "safe_name" = NULLIF(BTRIM("safe_name"), ''),
  "safe_description" = NULLIF(BTRIM("safe_description"), ''),
  "safe_category" = NULLIF(BTRIM("safe_category"), ''),
  "safe_image_url" = NULLIF(BTRIM("safe_image_url"), '');

DO $$
DECLARE
  has_short_description boolean;
  description_fallback_sql text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'catalog_items'
      AND column_name = 'short_description'
  ) INTO has_short_description;

  description_fallback_sql := CASE
    WHEN has_short_description THEN 'NULLIF(BTRIM("short_description"), ''''),'
    ELSE ''
  END;

  EXECUTE '
    UPDATE "catalog_items"
    SET
      "safe_name" = COALESCE(NULLIF(BTRIM("safe_name"), ''''), NULLIF(BTRIM("customer_safe_name"), ''''), NULLIF(BTRIM("name"), '''')),
      "safe_description" = COALESCE(NULLIF(BTRIM("safe_description"), ''''), NULLIF(BTRIM("customer_safe_description"), ''''), NULLIF(BTRIM("description"), ''''), ' || description_fallback_sql || ' NULLIF(BTRIM("display_description"), ''''), ''Converted into a customer-ready branded checkout presentation.''),
      "safe_category" = COALESCE(NULLIF(BTRIM("safe_category"), ''''), NULLIF(BTRIM("merchant_category"), ''''), NULLIF(BTRIM("lucifer_cruz_category"), ''''), NULLIF(BTRIM("display_category"), ''''), NULLIF(BTRIM("category"), '''')),
      "safe_image_url" = COALESCE(NULLIF(BTRIM("safe_image_url"), ''''), NULLIF(BTRIM("merchant_image"), ''''), NULLIF(BTRIM("lucifer_cruz_image_url"), ''''), NULLIF(BTRIM("display_image"), ''''), NULLIF(BTRIM("image_url"), ''''))
    WHERE
      "safe_name" IS NULL
      OR "safe_description" IS NULL
      OR "safe_category" IS NULL
      OR "safe_image_url" IS NULL';
END $$;

CREATE INDEX IF NOT EXISTS "catalog_items_safe_category_idx" ON "catalog_items" ("safe_category") WHERE "safe_category" IS NOT NULL;
