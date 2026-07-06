CREATE TABLE IF NOT EXISTS "inventory_transaction_log" (
  "id" serial PRIMARY KEY,
  "transaction_id" text NOT NULL,
  "type" text NOT NULL,
  "catalog_item_id" integer REFERENCES "catalog_items"("id"),
  "location_id" integer REFERENCES "inventory_locations"("id"),
  "quantity_change" numeric(10, 3) NOT NULL DEFAULT 0,
  "before_state" jsonb NOT NULL,
  "after_state" jsonb NOT NULL,
  "order_id" integer REFERENCES "orders"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transaction_log_transaction_id_idx" ON "inventory_transaction_log" ("transaction_id");
CREATE INDEX IF NOT EXISTS "inventory_transaction_log_order_idx" ON "inventory_transaction_log" ("order_id");
CREATE INDEX IF NOT EXISTS "inventory_transaction_log_catalog_location_idx" ON "inventory_transaction_log" ("catalog_item_id", "location_id");
