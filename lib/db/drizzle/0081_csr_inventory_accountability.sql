-- Contractor inventory accountability at shift close.
-- This is additive: no historical shift, inventory balance, or payout is changed.

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE shift_inventory_items
  ADD CONSTRAINT shift_inventory_items_shift_id_id_unique UNIQUE (shift_id, id);

CREATE TABLE contractor_inventory_adjustments (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  source_closeout_package_id integer NOT NULL,
  source_shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  original_amount numeric(12,2) NOT NULL CONSTRAINT contractor_inventory_adjustments_amount_positive CHECK (original_amount > 0),
  reason text NOT NULL CONSTRAINT contractor_inventory_adjustments_reason_length CHECK (length(btrim(reason)) >= 10),
  remainder_policy text NOT NULL CONSTRAINT contractor_inventory_adjustments_policy_check CHECK (remainder_policy = 'carry_forward_to_future_shift_payout'),
  confirmed_by_user_id integer NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_inventory_adjustments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT contractor_inventory_adjustments_tenant_package_unique UNIQUE (tenant_id, source_closeout_package_id),
  CONSTRAINT contractor_inventory_adjustments_tenant_package_fk FOREIGN KEY (tenant_id, source_closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT contractor_inventory_adjustments_tenant_shift_fk FOREIGN KEY (tenant_id, source_shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT contractor_inventory_adjustments_tenant_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT contractor_inventory_adjustments_tenant_confirmer_fk FOREIGN KEY (tenant_id, confirmed_by_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE contractor_inventory_adjustment_applications (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  adjustment_id integer NOT NULL,
  applied_closeout_package_id integer NOT NULL,
  applied_shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  amount numeric(12,2) NOT NULL CONSTRAINT contractor_inventory_apps_amount_positive CHECK (amount > 0),
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_inventory_apps_tenant_source_unique UNIQUE (tenant_id, source_key),
  CONSTRAINT contractor_inventory_apps_tenant_adjustment_fk FOREIGN KEY (tenant_id, adjustment_id) REFERENCES contractor_inventory_adjustments(tenant_id, id),
  CONSTRAINT contractor_inventory_apps_tenant_package_fk FOREIGN KEY (tenant_id, applied_closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT contractor_inventory_apps_tenant_shift_fk FOREIGN KEY (tenant_id, applied_shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT contractor_inventory_apps_tenant_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE shift_inventory_shortage_lines (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  closeout_package_id integer NOT NULL,
  adjustment_id integer NOT NULL,
  shift_id integer NOT NULL,
  csr_user_id integer NOT NULL,
  shift_inventory_item_id integer NOT NULL,
  catalog_item_id integer NOT NULL,
  location_id integer NOT NULL,
  inventory_movement_id integer NOT NULL,
  item_name_snapshot text NOT NULL,
  unit_of_measure_snapshot text NOT NULL,
  opening_quantity numeric(20,6) NOT NULL,
  non_sale_movement_delta numeric(20,6) NOT NULL,
  recorded_sales_quantity numeric(20,6) NOT NULL,
  expected_quantity numeric(20,6) NOT NULL,
  counted_quantity numeric(20,6) NOT NULL,
  missing_quantity numeric(20,6) NOT NULL,
  retail_price_snapshot numeric(12,2) NOT NULL,
  discount_rate numeric(9,6) NOT NULL,
  unit_replacement_value numeric(12,2) NOT NULL,
  line_total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_inventory_shortage_lines_tenant_shift_item_unique UNIQUE (tenant_id, shift_id, shift_inventory_item_id),
  CONSTRAINT shift_inventory_shortage_lines_quantity_check CHECK (opening_quantity >= 0 AND recorded_sales_quantity >= 0 AND expected_quantity >= 0 AND counted_quantity >= 0 AND missing_quantity > 0),
  CONSTRAINT shift_inventory_shortage_lines_money_check CHECK (retail_price_snapshot > 0 AND discount_rate = 0.2 AND unit_replacement_value > 0 AND line_total > 0),
  CONSTRAINT shift_inventory_shortage_lines_tenant_package_fk FOREIGN KEY (tenant_id, closeout_package_id) REFERENCES shift_closeout_packages(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_adjustment_fk FOREIGN KEY (tenant_id, adjustment_id) REFERENCES contractor_inventory_adjustments(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_csr_fk FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_catalog_fk FOREIGN KEY (tenant_id, catalog_item_id) REFERENCES catalog_items(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_tenant_movement_fk FOREIGN KEY (tenant_id, inventory_movement_id) REFERENCES inventory_movements(tenant_id, id),
  CONSTRAINT shift_inventory_shortage_lines_shift_item_fk FOREIGN KEY (shift_id, shift_inventory_item_id) REFERENCES shift_inventory_items(shift_id, id)
);

CREATE INDEX contractor_inventory_adjustments_tenant_csr_created_idx
  ON contractor_inventory_adjustments(tenant_id, csr_user_id, created_at, id);
CREATE INDEX contractor_inventory_apps_tenant_adjustment_idx
  ON contractor_inventory_adjustment_applications(tenant_id, adjustment_id);

DO $$
BEGIN
  CREATE TRIGGER contractor_inventory_adjustments_immutable
    BEFORE UPDATE OR DELETE ON contractor_inventory_adjustments
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  CREATE TRIGGER contractor_inventory_adjustment_applications_immutable
    BEFORE UPDATE OR DELETE ON contractor_inventory_adjustment_applications
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
  CREATE TRIGGER shift_inventory_shortage_lines_immutable
    BEFORE UPDATE OR DELETE ON shift_inventory_shortage_lines
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
END $$;
