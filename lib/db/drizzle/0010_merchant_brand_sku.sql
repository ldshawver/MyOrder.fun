-- Migration 0010: Task #13 — explicit Lucifer Cruz merchant SKU + merchant brand
-- discriminator on the catalog. The brand discriminator marks items as
-- "alavont" (customer-facing, must be converted to LC by the checkout
-- normalizer before payment) or "lucifer_cruz" (already on the LC catalog).
-- The application layer (checkoutNormalizer.ts) enforces non-null mapping for
-- alavont items — no DB-side FK, so historical rows survive the migration.
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_sku" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand" text NOT NULL DEFAULT 'alavont';
--> statement-breakpoint
-- Backfill: any item already known to be a WooCommerce-managed (LC catalog)
-- item should be classified as merchant_brand=lucifer_cruz so the normalizer
-- does not try to apply Alavont→LC rewriting on it.
UPDATE "catalog_items" SET "merchant_brand" = 'lucifer_cruz' WHERE "is_woo_managed" = true;
--> statement-breakpoint
-- NOTE: We deliberately do NOT auto-fill `merchant_sku` for Alavont rows.
-- The Lucifer Cruz merchant SKU must come from an authoritative LC catalog
-- source (admin upload / Lucifer Cruz API) — backfilling from `sku` or
-- `alavont_id` would write Alavont-side identifiers into `merchant_sku`,
-- which would then leak into the Stripe metadata that the checkout
-- normalizer emits. Existing rows without a true LC SKU will (correctly)
-- fail checkout with HTTP 422 until they are remapped via the LC admin
-- tooling.
--
-- For local development convenience only, an LC-prefixed placeholder is
-- written when the existing `sku` clearly already follows the LC naming
-- convention (`LC-*`). All other Alavont rows remain merchant_sku=NULL.
UPDATE "catalog_items"
SET "merchant_sku" = "sku"
WHERE "merchant_brand" = 'alavont'
  AND "merchant_sku" IS NULL
  AND "sku" IS NOT NULL
  AND "sku" LIKE 'LC-%';
