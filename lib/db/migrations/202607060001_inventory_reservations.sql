CREATE TABLE IF NOT EXISTS "inventory_reservations" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "catalog_item_id" integer NOT NULL REFERENCES "catalog_items"("id"),
  "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
  "quantity" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "idempotency_key" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id");
CREATE INDEX IF NOT EXISTS "inventory_reservations_active_idx" ON "inventory_reservations" ("catalog_item_id", "location_id", "status", "expires_at");

ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_idempotency_key_idx" ON "inventory_reservations" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
