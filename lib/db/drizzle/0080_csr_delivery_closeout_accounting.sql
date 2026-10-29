-- Canonical continuation of the verified production migration journal.
-- Legacy quoted records without provider ETA are expired and must be requoted.
-- Consumed records retain NULL ETA: do not fabricate a provider ETA from local timestamps.

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
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_commission_amounts_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_commission_amounts_check
  CHECK (commission_gross_amount >= 0 AND commission_discount_amount >= 0 AND commission_discount_amount <= commission_gross_amount);

ALTER TABLE uber_delivery_quotes
  ADD COLUMN IF NOT EXISTS dropoff_eta timestamptz,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS pickup_duration_seconds integer;
ALTER TABLE uber_delivery_quotes ALTER COLUMN dropoff_eta DROP NOT NULL;
UPDATE uber_delivery_quotes
  SET status = 'expired'
  WHERE status = 'quoted' AND consumed_at IS NULL AND dropoff_eta IS NULL;

-- Composite target for tenant-scoped references from the two accounting ledgers.
ALTER TABLE shift_closeout_packages
  ADD CONSTRAINT shift_closeout_packages_tenant_id_id_unique UNIQUE (tenant_id, id);

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT c.conname, c.conrelid::regclass AS table_name
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'shift_closeout_packages'::regclass
      AND (c.conrelid = to_regclass('commission_snapshots') OR c.conrelid = to_regclass('shift_earning_lines'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE commission_snapshots
  ADD CONSTRAINT commission_snapshots_tenant_package_fk
  FOREIGN KEY (tenant_id, closeout_package_id)
  REFERENCES shift_closeout_packages (tenant_id, id);

CREATE TABLE IF NOT EXISTS shift_earning_lines (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  closeout_package_id integer NOT NULL,
  shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  kind text NOT NULL CONSTRAINT shift_earning_lines_kind_check CHECK (kind IN ('product_commission','customer_tip','csr_delivery','house_delivery','uber_provider_delivery','commission_refund_adjustment')),
  amount numeric(12,2) NOT NULL CONSTRAINT shift_earning_lines_amount_nonnegative CHECK (amount >= 0),
  source_key text NOT NULL,
  source_order_id integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_earning_lines_tenant_package_fk FOREIGN KEY (tenant_id, closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT shift_earning_lines_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT shift_earning_lines_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT shift_earning_lines_tenant_source_unique UNIQUE (tenant_id, source_key)
);

ALTER TABLE shift_earning_lines DROP CONSTRAINT IF EXISTS shift_earning_lines_kind_check;
ALTER TABLE shift_earning_lines DROP CONSTRAINT IF EXISTS shift_earning_lines_amount_check;
ALTER TABLE shift_earning_lines DROP CONSTRAINT IF EXISTS shift_earning_lines_amount_nonnegative;
ALTER TABLE shift_earning_lines ADD CONSTRAINT shift_earning_lines_kind_check
  CHECK (kind IN ('product_commission','customer_tip','csr_delivery','house_delivery','uber_provider_delivery','commission_refund_adjustment'));
ALTER TABLE shift_earning_lines ADD CONSTRAINT shift_earning_lines_amount_nonnegative CHECK (amount >= 0);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'shift_earning_lines'::regclass
      AND conname = 'shift_earning_lines_tenant_package_fk'
  ) THEN
    ALTER TABLE shift_earning_lines
      ADD CONSTRAINT shift_earning_lines_tenant_package_fk
      FOREIGN KEY (tenant_id, closeout_package_id)
      REFERENCES shift_closeout_packages (tenant_id, id);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'shift_earning_lines'::regclass
      AND conname = 'shift_earning_lines_tenant_order_fk'
  ) THEN
    ALTER TABLE shift_earning_lines
      ADD CONSTRAINT shift_earning_lines_tenant_order_fk
      FOREIGN KEY (tenant_id, source_order_id)
      REFERENCES orders (tenant_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shift_commission_order_snapshots (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  closeout_package_id integer NOT NULL,
  shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  order_id integer NOT NULL,
  commission_basis numeric(12,2) NOT NULL CONSTRAINT shift_commission_order_snapshots_basis_nonnegative CHECK (commission_basis >= 0),
  commission_rate numeric(9,6) NOT NULL CONSTRAINT shift_commission_order_snapshots_rate_check CHECK (commission_rate >= 0 AND commission_rate <= 1),
  commission_amount numeric(12,2) NOT NULL CONSTRAINT shift_commission_order_snapshots_amount_nonnegative CHECK (commission_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_commission_order_snapshots_tenant_order_unique UNIQUE (tenant_id, order_id),
  CONSTRAINT shift_commission_order_snapshots_tenant_package_fk FOREIGN KEY (tenant_id, closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT shift_commission_order_snapshots_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT shift_commission_order_snapshots_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT shift_commission_order_snapshots_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS commission_refund_adjustments (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  original_closeout_package_id integer NOT NULL,
  original_shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  order_id integer NOT NULL,
  return_id integer NOT NULL,
  amount numeric(12,2) NOT NULL CONSTRAINT commission_refund_adjustments_amount_positive CHECK (amount > 0),
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_refund_adjustments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT commission_refund_adjustments_tenant_source_unique UNIQUE (tenant_id, source_key),
  CONSTRAINT commission_refund_adjustments_tenant_package_fk FOREIGN KEY (tenant_id, original_closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT commission_refund_adjustments_tenant_shift_fk FOREIGN KEY (tenant_id, original_shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT commission_refund_adjustments_tenant_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT commission_refund_adjustments_tenant_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS shift_earning_adjustment_applications (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  adjustment_id integer NOT NULL,
  closeout_package_id integer NOT NULL,
  shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  amount numeric(12,2) NOT NULL CONSTRAINT shift_earning_adjustment_applications_amount_positive CHECK (amount > 0),
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_earning_adjustment_applications_tenant_source_unique UNIQUE (tenant_id, source_key),
  CONSTRAINT shift_earning_adjustment_applications_tenant_adjustment_fk FOREIGN KEY (tenant_id, adjustment_id) REFERENCES commission_refund_adjustments(tenant_id, id),
  CONSTRAINT shift_earning_adjustment_applications_tenant_package_fk FOREIGN KEY (tenant_id, closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT shift_earning_adjustment_applications_tenant_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT shift_earning_adjustment_applications_tenant_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS commission_refund_adjustments_tenant_csr_created_idx
  ON commission_refund_adjustments(tenant_id, csr_user_id, created_at, id);
CREATE INDEX IF NOT EXISTS shift_earning_adjustment_applications_tenant_adjustment_idx
  ON shift_earning_adjustment_applications(tenant_id, adjustment_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'shift_earning_lines'::regclass AND tgname = 'shift_earning_lines_immutable') THEN
    CREATE TRIGGER shift_earning_lines_immutable
      BEFORE UPDATE OR DELETE ON shift_earning_lines
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'shift_commission_order_snapshots'::regclass AND tgname = 'shift_commission_order_snapshots_immutable') THEN
    CREATE TRIGGER shift_commission_order_snapshots_immutable
      BEFORE UPDATE OR DELETE ON shift_commission_order_snapshots
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'commission_refund_adjustments'::regclass AND tgname = 'commission_refund_adjustments_immutable') THEN
    CREATE TRIGGER commission_refund_adjustments_immutable
      BEFORE UPDATE OR DELETE ON commission_refund_adjustments
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'shift_earning_adjustment_applications'::regclass AND tgname = 'shift_earning_adjustment_applications_immutable') THEN
    CREATE TRIGGER shift_earning_adjustment_applications_immutable
      BEFORE UPDATE OR DELETE ON shift_earning_adjustment_applications
      FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  END IF;
END $$;
