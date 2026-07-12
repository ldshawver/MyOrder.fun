-- Idempotent production schema repair for CSR shift check-in/order routing.
-- Keeps assigned_shift_id nullable so empty/default-queue orders are valid, but
-- ensures all columns referenced by runtime shift/routing code exist.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_shift_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_to" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_strategy" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_message" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "route_source" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promised_minutes" integer DEFAULT 30;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimated_ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eta_adjusted_by_supervisor" boolean NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_status" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_assigned_shift_id_lab_tech_shifts_id_fk'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_assigned_shift_id_lab_tech_shifts_id_fk"
      FOREIGN KEY ("assigned_shift_id") REFERENCES "lab_tech_shifts"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx" ON "orders" ("assigned_shift_id");
CREATE INDEX IF NOT EXISTS "orders_tenant_assigned_shift_idx" ON "orders" ("tenant_id", "assigned_shift_id");
CREATE INDEX IF NOT EXISTS "orders_assigned_csr_idx" ON "orders" ("assigned_csr_user_id");
CREATE INDEX IF NOT EXISTS "orders_routing_status_idx" ON "orders" ("routing_status");
