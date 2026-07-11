-- Phase 1 order lifecycle remediation: persist distinct preparing actor/time.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepared_by_user_id" integer REFERENCES "users"("id");

-- Normalize legacy fulfillment/status values into the canonical lifecycle vocabulary.
UPDATE "orders"
SET "fulfillment_status" = CASE
  WHEN "fulfillment_status" IN ('accepted', 'in_progress') THEN 'in_progress'
  WHEN "fulfillment_status" = 'preparing' THEN 'preparing'
  WHEN "fulfillment_status" IN ('ready', 'ready_behind_gate', 'courier_arrived') THEN 'ready'
  WHEN "fulfillment_status" IN ('complete', 'completed', 'handed_off') THEN 'completed'
  WHEN "fulfillment_status" IN ('cancelled', 'voided', 'archived') THEN 'cancelled'
  WHEN "fulfillment_status" = 'refunded' THEN 'refunded'
  WHEN "fulfillment_status" = 'reconciliation_required' THEN 'reconciliation_required'
  WHEN "fulfillment_status" IS NULL AND "status" IN ('pending', 'submitted') THEN 'submitted'
  ELSE "fulfillment_status"
END
WHERE "fulfillment_status" IS NULL
   OR "fulfillment_status" IN ('accepted', 'ready_behind_gate', 'courier_arrived', 'complete', 'handed_off', 'voided', 'archived');

UPDATE "orders"
SET "status" = CASE
  WHEN "status" = 'pending' THEN 'submitted'
  WHEN "status" IN ('accepted', 'processing') THEN COALESCE("fulfillment_status", 'in_progress')
  WHEN "status" = 'delivered' THEN 'completed'
  WHEN "status" IN ('voided', 'archived') THEN 'cancelled'
  ELSE "status"
END
WHERE "status" IN ('pending', 'accepted', 'processing', 'delivered', 'voided', 'archived');

CREATE INDEX IF NOT EXISTS "orders_fulfillment_status_idx" ON "orders" ("fulfillment_status");
CREATE INDEX IF NOT EXISTS "orders_prepared_at_idx" ON "orders" ("prepared_at");
