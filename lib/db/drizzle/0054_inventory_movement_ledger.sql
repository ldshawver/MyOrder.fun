-- Phase 1 Slice 3: immutable tenant-scoped inventory movement ledger.
-- This migration is deliberately additive. Existing balances have no fabricated
-- receipt or valuation history; valuation state is initialized lazily by the
-- movement service as known or unknown_baseline.

ALTER TABLE "inventory_receipts"
  ADD COLUMN IF NOT EXISTS "actual_unit_cost" numeric(24, 12),
  ADD COLUMN IF NOT EXISTS "supplier_reference" text,
  ADD COLUMN IF NOT EXISTS "received_at" timestamptz;

CREATE TABLE IF NOT EXISTS "inventory_valuation_states" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "inventory_entity_type" text NOT NULL,
  "catalog_item_id" integer REFERENCES "catalog_items"("id"),
  "non_catalog_item_id" integer REFERENCES "non_catalog_inventory_items"("id"),
  "cost_status" text NOT NULL DEFAULT 'known',
  "known_quantity" numeric(24, 12) NOT NULL DEFAULT 0,
  "average_unit_cost" numeric(24, 12),
  "inventory_value" numeric(24, 12),
  "last_purchase_unit_cost" numeric(24, 12),
  "last_purchase_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_valuation_states_entity_type_check" CHECK (
    ("inventory_entity_type" = 'catalog' AND "catalog_item_id" IS NOT NULL AND "non_catalog_item_id" IS NULL)
    OR
    ("inventory_entity_type" = 'non_catalog' AND "catalog_item_id" IS NULL AND "non_catalog_item_id" IS NOT NULL)
  ),
  CONSTRAINT "inventory_valuation_states_cost_status_check" CHECK ("cost_status" IN ('known', 'unknown_baseline')),
  CONSTRAINT "inventory_valuation_states_known_quantity_nonnegative" CHECK ("known_quantity" >= 0),
  CONSTRAINT "inventory_valuation_states_value_nonnegative" CHECK ("inventory_value" IS NULL OR "inventory_value" >= 0),
  CONSTRAINT "inventory_valuation_states_tenant_catalog_fk" FOREIGN KEY ("tenant_id", "catalog_item_id") REFERENCES "catalog_items"("tenant_id", "id"),
  CONSTRAINT "inventory_valuation_states_tenant_non_catalog_fk" FOREIGN KEY ("tenant_id", "non_catalog_item_id") REFERENCES "non_catalog_inventory_items"("tenant_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_valuation_states_catalog_unique"
  ON "inventory_valuation_states" ("tenant_id", "catalog_item_id")
  WHERE "catalog_item_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_valuation_states_non_catalog_unique"
  ON "inventory_valuation_states" ("tenant_id", "non_catalog_item_id")
  WHERE "non_catalog_item_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "inventory_movements" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "inventory_entity_type" text NOT NULL,
  "catalog_item_id" integer REFERENCES "catalog_items"("id"),
  "non_catalog_item_id" integer REFERENCES "non_catalog_inventory_items"("id"),
  "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
  "destination_location_id" integer REFERENCES "inventory_locations"("id"),
  "movement_type" text NOT NULL,
  "quantity_delta" numeric(24, 12) NOT NULL,
  "unit_of_measure" text NOT NULL,
  "unit_cost" numeric(24, 12),
  "extended_cost" numeric(24, 12),
  "pre_quantity" numeric(24, 12) NOT NULL,
  "post_quantity" numeric(24, 12) NOT NULL,
  "pre_average_unit_cost" numeric(24, 12),
  "post_average_unit_cost" numeric(24, 12),
  "source_type" text NOT NULL,
  "source_id" text,
  "order_id" integer REFERENCES "orders"("id"),
  "order_item_id" integer REFERENCES "order_items"("id"),
  "receipt_id" integer REFERENCES "inventory_receipts"("id"),
  "supplier_reference" text,
  "reason_code" text,
  "reason_text" text,
  "idempotency_key" text NOT NULL,
  "movement_index" smallint NOT NULL DEFAULT 0,
  "correlation_id" text NOT NULL,
  "actor_user_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_movements_entity_type_check" CHECK (
    ("inventory_entity_type" = 'catalog' AND "catalog_item_id" IS NOT NULL AND "non_catalog_item_id" IS NULL)
    OR
    ("inventory_entity_type" = 'non_catalog' AND "catalog_item_id" IS NULL AND "non_catalog_item_id" IS NOT NULL)
  ),
  CONSTRAINT "inventory_movements_type_check" CHECK ("movement_type" IN (
    'receipt', 'sale', 'usage', 'transfer_out', 'transfer_in', 'customer_return',
    'vendor_return', 'waste', 'damage', 'shrinkage', 'adjustment_increase',
    'adjustment_decrease', 'correction'
  )),
  CONSTRAINT "inventory_movements_quantity_nonzero" CHECK ("quantity_delta" <> 0),
  CONSTRAINT "inventory_movements_cost_nonnegative" CHECK (
    ("unit_cost" IS NULL OR "unit_cost" >= 0) AND ("extended_cost" IS NULL OR "extended_cost" >= 0)
  ),
  CONSTRAINT "inventory_movements_post_quantity_nonnegative" CHECK ("post_quantity" >= 0),
  CONSTRAINT "inventory_movements_tenant_catalog_fk" FOREIGN KEY ("tenant_id", "catalog_item_id") REFERENCES "catalog_items"("tenant_id", "id"),
  CONSTRAINT "inventory_movements_tenant_non_catalog_fk" FOREIGN KEY ("tenant_id", "non_catalog_item_id") REFERENCES "non_catalog_inventory_items"("tenant_id", "id"),
  CONSTRAINT "inventory_movements_tenant_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id"),
  CONSTRAINT "inventory_movements_tenant_destination_location_fk" FOREIGN KEY ("tenant_id", "destination_location_id") REFERENCES "inventory_locations"("tenant_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_tenant_idempotency_index_unique"
  ON "inventory_movements" ("tenant_id", "idempotency_key", "movement_index");
CREATE INDEX IF NOT EXISTS "inventory_movements_tenant_entity_created_idx"
  ON "inventory_movements" ("tenant_id", "inventory_entity_type", "catalog_item_id", "non_catalog_item_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "inventory_movements_tenant_location_created_idx"
  ON "inventory_movements" ("tenant_id", "location_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "inventory_movements_tenant_type_created_idx"
  ON "inventory_movements" ("tenant_id", "movement_type", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "inventory_movements_order_idx"
  ON "inventory_movements" ("tenant_id", "order_id") WHERE "order_id" IS NOT NULL;

ALTER TABLE "inventory_receipts"
  ADD COLUMN IF NOT EXISTS "movement_id" integer REFERENCES "inventory_movements"("id");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_receipts_movement_id_unique"
  ON "inventory_receipts" ("movement_id") WHERE "movement_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "prevent_inventory_movement_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory movement rows are immutable; post a compensating correction instead';
END;
$$;

DROP TRIGGER IF EXISTS "inventory_movements_immutable_trigger" ON "inventory_movements";
CREATE TRIGGER "inventory_movements_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "prevent_inventory_movement_mutation"();
