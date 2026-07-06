DO $$
BEGIN
  ALTER TABLE "inventory_balances"
    ADD CONSTRAINT "inventory_balances_quantity_nonnegative_chk"
    CHECK ("quantity_on_hand" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "inventory_reservations"
    ADD CONSTRAINT "inventory_reservations_quantity_positive_chk"
    CHECK ("quantity" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "inventory_reservations"
    ADD CONSTRAINT "inventory_reservations_idempotency_present_chk"
    CHECK ("idempotency_key" IS NOT NULL AND btrim("idempotency_key") <> '') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "inventory_balances_negative_guard_idx"
  ON "inventory_balances" ("product_id", "location_id")
  WHERE "quantity_on_hand" < 0;

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_active_idempotency_idx"
  ON "inventory_reservations" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND "status" IN ('reserved', 'confirmed');
