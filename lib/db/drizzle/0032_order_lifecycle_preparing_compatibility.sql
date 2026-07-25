-- Additive production reconciliation for the canonical preparing lifecycle.
-- Existing lifecycle values are intentionally not rewritten in this migration.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_by_user_id" integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "orders" o
    LEFT JOIN "users" u ON u."id" = o."prepared_by_user_id"
    WHERE o."prepared_by_user_id" IS NOT NULL AND u."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add orders.prepared_by_user_id foreign key: orphan rows exist'
      USING ERRCODE = 'foreign_key_violation';
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
      AND a.attname = 'prepared_by_user_id'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_prepared_by_user_id_users_id_fk"
      FOREIGN KEY ("prepared_by_user_id") REFERENCES "users"("id") NOT VALID;
    ALTER TABLE "orders"
      VALIDATE CONSTRAINT "orders_prepared_by_user_id_users_id_fk";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "orders_fulfillment_status_idx"
  ON "orders" ("fulfillment_status");
CREATE INDEX IF NOT EXISTS "orders_prepared_at_idx"
  ON "orders" ("prepared_at");
