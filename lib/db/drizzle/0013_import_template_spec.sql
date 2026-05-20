-- Migration 0013: Admin-editable menu import template spec.
-- Stores the visible spreadsheet header labels/order and optional custom
-- columns that the import backend should accept.
--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "import_template_spec" text;
