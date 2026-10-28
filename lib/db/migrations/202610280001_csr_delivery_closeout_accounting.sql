ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS commission_eligibility text NOT NULL DEFAULT 'unclassified';

ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_commission_eligibility_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_commission_eligibility_check
  CHECK (commission_eligibility IN ('eligible', 'membership', 'excluded', 'unclassified'));

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS commission_eligibility_snapshot text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS commission_gross_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_discount_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_commission_eligibility_snapshot_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_commission_eligibility_snapshot_check
  CHECK (commission_eligibility_snapshot IN ('eligible', 'membership', 'excluded', 'unclassified'));

ALTER TABLE uber_delivery_quotes
  ADD COLUMN IF NOT EXISTS dropoff_eta timestamptz,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS pickup_duration_seconds integer;

-- Existing unconsumed quotes cannot prove the ETA used for a new checkout.
UPDATE uber_delivery_quotes SET status = 'expired' WHERE status = 'quoted' AND dropoff_eta IS NULL;
UPDATE uber_delivery_quotes SET dropoff_eta = COALESCE(consumed_at, expires_at, created_at) WHERE dropoff_eta IS NULL;
ALTER TABLE uber_delivery_quotes ALTER COLUMN dropoff_eta SET NOT NULL;

CREATE TABLE IF NOT EXISTS shift_earning_lines (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  closeout_package_id integer NOT NULL REFERENCES shift_closeout_packages(id),
  shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('product_commission','customer_tip','csr_delivery','house_delivery','uber_provider_delivery')),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  source_key text NOT NULL,
  source_order_id integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_earning_lines_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT shift_earning_lines_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT shift_earning_lines_tenant_source_unique UNIQUE (tenant_id, source_key)
);
