-- Migration 0008: 14-column menu import (Task #10) — add new fields
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "external_menu_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_amount" numeric(10,2);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "unit_measurement" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_name" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_description" text;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text;
