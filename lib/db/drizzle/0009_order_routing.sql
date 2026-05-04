-- Migration 0009: Order routing + customer hourglass (Task #12)
-- Field naming follows the spec: assigned_csr_user_id / route_source / promised_minutes.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "route_source" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promised_minutes" integer DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimated_ready_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ready_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eta_adjusted_by_supervisor" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "order_routing_rule" text NOT NULL DEFAULT 'round_robin';
--> statement-breakpoint
-- Backfill prior round-1 vocabulary into the spec vocabulary
UPDATE "admin_settings" SET "order_routing_rule" = 'round_robin' WHERE "order_routing_rule" IN ('single_active');
--> statement-breakpoint
UPDATE "admin_settings" SET "order_routing_rule" = 'least_recent_order' WHERE "order_routing_rule" = 'least_recent';
--> statement-breakpoint
UPDATE "admin_settings" SET "order_routing_rule" = 'supervisor_manual_assignment' WHERE "order_routing_rule" = 'supervisor_manual';
--> statement-breakpoint
UPDATE "orders" SET "route_source" = 'active_csr' WHERE "route_source" IN ('single_active', 'round_robin', 'least_recent');
--> statement-breakpoint
UPDATE "orders" SET "route_source" = 'supervisor_override' WHERE "route_source" = 'supervisor_manual';
--> statement-breakpoint
-- Backfill historical rows that pre-date routing: anything still null gets
-- a deterministic fallback so historical data is consistent with the new
-- spec vocabulary. Rows that have an assigned CSR are stamped 'active_csr',
-- everything else falls into 'general_account'.
UPDATE "orders" SET "route_source" = 'active_csr'
  WHERE "route_source" IS NULL AND "assigned_csr_user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "orders" SET "route_source" = 'general_account'
  WHERE "route_source" IS NULL;
--> statement-breakpoint
UPDATE "orders" SET "fulfillment_status" = 'ready' WHERE "fulfillment_status" IN ('ready_behind_gate', 'courier_arrived');
--> statement-breakpoint
UPDATE "orders" SET "fulfillment_status" = 'completed' WHERE "fulfillment_status" IN ('handed_off', 'complete');
--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "default_eta_minutes" integer NOT NULL DEFAULT 30;
