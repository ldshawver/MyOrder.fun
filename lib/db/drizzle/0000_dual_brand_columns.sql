-- Incremental migration: dual-brand (Alavont/Lucifer Cruz) columns
-- Additive-only — all statements use IF NOT EXISTS for safety on existing databases.
-- This migration adds the columns required for the dual-catalog dual-merchant product flow.

--> statement-breakpoint
-- catalog_items: Alavont brand columns
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_image_url" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_in_stock" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_upsell" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_sample" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_date" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_updated_date" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_by_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_by" text;
--> statement-breakpoint

-- catalog_items: Lucifer Cruz / WooCommerce merchant columns
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_image_url" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_product_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_variation_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_processing_mode" text DEFAULT 'mapped_lucifer';
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_product_source" text DEFAULT 'local_mapped';
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "receipt_name" text;
--> statement-breakpoint

-- order_items: dual-brand snapshot + CJ Dropshipping linkage
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "alavont_name" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "receipt_name" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "label_name" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "lab_name" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "woo_product_id" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "woo_variation_id" text;
--> statement-breakpoint

-- admin_settings: receipt print mode for dual-brand receipts
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "receipt_line_name_mode" text DEFAULT 'lucifer_only';
