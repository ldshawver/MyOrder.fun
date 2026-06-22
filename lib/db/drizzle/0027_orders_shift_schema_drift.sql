-- Idempotent repair for live orders tables used by CSR shift/order routing.
-- Safety: this migration only adds missing columns/indexes. It does not UPDATE, DELETE, TRUNCATE, DROP, or backfill existing order/shift data.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_shift_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_to" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_strategy" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_message" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "route_source" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promised_minutes" integer DEFAULT 30;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimated_ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eta_adjusted_by_supervisor" boolean NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_status" text;
CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx" ON "orders" ("assigned_shift_id");
CREATE INDEX IF NOT EXISTS "orders_assigned_csr_idx" ON "orders" ("assigned_csr_user_id");
