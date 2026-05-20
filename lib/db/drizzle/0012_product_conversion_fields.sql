-- Migration 0012: Production product-conversion data model.
-- Adds separate operational/source fields and customer-facing converted
-- checkout fields. Existing rows keep working because every field is nullable
-- or has a safe default; the application derives polished fallback copy from
-- the current Alavont/Lucifer Cruz columns until admins curate overrides.
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_category" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_category" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "backend_inventory_notes" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "vendor_sku" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "source_inventory_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "cost_basis" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_tracking_data" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "marketing_copy" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "upsell_copy" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "promo_badges" text[] DEFAULT ARRAY[]::text[];
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "final_confirmation_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "legal_disclaimer_accepted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "legal_disclaimer_text" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_conversion_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "selected_payment_method" text;
