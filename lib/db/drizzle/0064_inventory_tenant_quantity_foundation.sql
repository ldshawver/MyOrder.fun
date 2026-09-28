-- Tenant attribution for new journals and exact physical quantities.
DO $$ BEGIN
  IF to_regclass('inventory_transaction_log') IS NOT NULL THEN
    ALTER TABLE inventory_transaction_log ADD COLUMN IF NOT EXISTS tenant_id integer;
    ALTER TABLE inventory_transaction_log ALTER COLUMN quantity_change TYPE numeric(20, 6) USING quantity_change::numeric(20, 6);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transaction_log_tenant_required') THEN
      ALTER TABLE inventory_transaction_log ADD CONSTRAINT inventory_transaction_log_tenant_required CHECK (tenant_id IS NOT NULL) NOT VALID;
    END IF;
  END IF;
  IF to_regclass('inventory_reservations') IS NOT NULL THEN
    ALTER TABLE inventory_reservations ALTER COLUMN quantity TYPE numeric(20, 6) USING quantity::numeric(20, 6);
  END IF;
END $$;
ALTER TABLE inventory_balances ALTER COLUMN quantity_on_hand TYPE numeric(20, 6) USING quantity_on_hand::numeric(20, 6);
CREATE TABLE IF NOT EXISTS inventory_restorations (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  product_id integer NOT NULL REFERENCES catalog_items(id),
  location_id integer NOT NULL REFERENCES inventory_locations(id),
  quantity numeric(20, 6) NOT NULL CHECK (quantity > 0),
  idempotency_key text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE inventory_balances ALTER COLUMN par_level TYPE numeric(20, 6) USING par_level::numeric(20, 6);
