-- Idempotent repair for live orders lifecycle columns selected by the API Drizzle schema.
-- Safety: this migration only adds missing columns/indexes. It does not UPDATE, DELETE, TRUNCATE, DROP, or backfill existing orders.
-- Rollback notes only: if rollback is ever required, first confirm no deployed code reads these columns, then drop the indexes and columns manually during a maintenance window.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_by_user_id" integer REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS "orders_archived_at_idx" ON "orders" ("archived_at");
CREATE INDEX IF NOT EXISTS "orders_voided_at_idx" ON "orders" ("voided_at");
CREATE INDEX IF NOT EXISTS "orders_cancelled_at_idx" ON "orders" ("cancelled_at");
CREATE INDEX IF NOT EXISTS "orders_completed_at_idx" ON "orders" ("completed_at");
