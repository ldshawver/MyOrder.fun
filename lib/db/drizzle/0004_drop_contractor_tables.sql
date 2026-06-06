-- Migration 0004: drop Contractor Hub tables (feature removed; belongs to a different product)
--> statement-breakpoint
DROP TABLE IF EXISTS "contractor_invoices" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "contractor_proposals" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "contractor_templates" CASCADE;
