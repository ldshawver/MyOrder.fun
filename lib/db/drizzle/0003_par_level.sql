-- Migration 0003: add par_level to catalog_items and inventory_templates
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "par_level" numeric(10,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "par_level" numeric(10,2) DEFAULT 0;
