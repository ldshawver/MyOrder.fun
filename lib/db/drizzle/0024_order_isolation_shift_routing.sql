ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_to" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_strategy" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_message" text;

CREATE TABLE IF NOT EXISTS "shift_routing_config" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "allow_multiple_active_shifts" boolean NOT NULL DEFAULT false,
  "routing_strategy" text NOT NULL,
  "approved_by_user_id" integer REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "orders_tenant_status_idx" ON "orders" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "orders_customer_idx" ON "orders" ("customer_id");
CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx" ON "orders" ("assigned_shift_id");
CREATE INDEX IF NOT EXISTS "shifts_tenant_status_idx" ON "lab_tech_shifts" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "shift_routing_config_tenant_idx" ON "shift_routing_config" ("tenant_id");
