-- Additive repair for deployments that missed 0024_order_isolation_shift_routing.sql.
-- Creates the tenant-scoped shift routing configuration table used by checkout
-- order routing. Non-destructive and idempotent.
CREATE TABLE IF NOT EXISTS "shift_routing_config" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "allow_multiple_active_shifts" boolean NOT NULL DEFAULT false,
  "routing_strategy" text NOT NULL DEFAULT 'round_robin',
  "approved_by_user_id" integer REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "reason" text DEFAULT 'default system fallback',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "allow_multiple_active_shifts" boolean NOT NULL DEFAULT false;
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "routing_strategy" text NOT NULL DEFAULT 'round_robin';
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "approved_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "reason" text DEFAULT 'default system fallback';
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();
ALTER TABLE "shift_routing_config" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "shift_routing_config_tenant_idx" ON "shift_routing_config" ("tenant_id");
