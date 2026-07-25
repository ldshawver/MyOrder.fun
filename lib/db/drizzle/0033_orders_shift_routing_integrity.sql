-- Additive production reconciliation for CSR shift routing.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_shift_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_strategy" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routing_message" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "route_source" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_to" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promised_minutes" integer DEFAULT 30;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimated_ready_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eta_adjusted_by_supervisor" boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  assigned_shift_constraint record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "orders" o
    LEFT JOIN "lab_tech_shifts" s ON s."id" = o."assigned_shift_id"
    WHERE o."assigned_shift_id" IS NOT NULL AND s."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add orders.assigned_shift_id foreign key: orphan rows exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "orders" o
    LEFT JOIN "users" u ON u."id" = o."assigned_csr_user_id"
    WHERE o."assigned_csr_user_id" IS NOT NULL AND u."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add orders.assigned_csr_user_id foreign key: orphan rows exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT c.conname, c.confdeltype
  INTO assigned_shift_constraint
  FROM pg_constraint c
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid
   AND a.attnum = ANY (c.conkey)
  WHERE c.conrelid = 'orders'::regclass
    AND c.contype = 'f'
    AND c.confrelid = 'lab_tech_shifts'::regclass
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'assigned_shift_id'
  LIMIT 1;

  IF assigned_shift_constraint.conname IS NULL THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_assigned_shift_id_lab_tech_shifts_id_fk"
      FOREIGN KEY ("assigned_shift_id") REFERENCES "lab_tech_shifts"("id")
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE "orders"
      VALIDATE CONSTRAINT "orders_assigned_shift_id_lab_tech_shifts_id_fk";
  ELSIF assigned_shift_constraint.confdeltype <> 'n' THEN
    EXECUTE format(
      'ALTER TABLE "orders" DROP CONSTRAINT %I',
      assigned_shift_constraint.conname
    );
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_assigned_shift_id_lab_tech_shifts_id_fk"
      FOREIGN KEY ("assigned_shift_id") REFERENCES "lab_tech_shifts"("id")
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE "orders"
      VALIDATE CONSTRAINT "orders_assigned_shift_id_lab_tech_shifts_id_fk";
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'orders'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'users'::regclass
      AND array_length(c.conkey, 1) = 1
      AND a.attname = 'assigned_csr_user_id'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_assigned_csr_user_id_users_id_fk"
      FOREIGN KEY ("assigned_csr_user_id") REFERENCES "users"("id") NOT VALID;
    ALTER TABLE "orders"
      VALIDATE CONSTRAINT "orders_assigned_csr_user_id_users_id_fk";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "orders_tenant_assigned_shift_idx"
  ON "orders" ("tenant_id", "assigned_shift_id");
CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx"
  ON "orders" ("assigned_shift_id");
CREATE INDEX IF NOT EXISTS "orders_assigned_csr_idx"
  ON "orders" ("assigned_csr_user_id");
CREATE INDEX IF NOT EXISTS "orders_routing_status_idx"
  ON "orders" ("routing_status");
