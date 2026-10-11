-- Durable tenant-scoped Woo import jobs. A partial unique index is the final
-- concurrency guard; request enqueueing also takes a tenant advisory lock.
CREATE TABLE woocommerce_sync_jobs (
  id text PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  requested_by integer NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  processed_parents integer NOT NULL DEFAULT 0,
  total_parents integer NOT NULL DEFAULT 0,
  processed_variants integer NOT NULL DEFAULT 0,
  total_variants integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT woocommerce_sync_jobs_state_check CHECK (state IN ('queued','running','succeeded','failed','interrupted')),
  CONSTRAINT woocommerce_sync_jobs_counts_nonnegative CHECK (
    attempt_count >= 0 AND processed_parents >= 0 AND total_parents >= 0 AND
    processed_variants >= 0 AND total_variants >= 0 AND created_count >= 0 AND
    updated_count >= 0 AND skipped_count >= 0 AND failed_count >= 0
  ),
  CONSTRAINT woocommerce_sync_jobs_error_array CHECK (jsonb_typeof(error_summary) = 'array')
);
CREATE UNIQUE INDEX woocommerce_sync_jobs_one_active_tenant_idx
  ON woocommerce_sync_jobs(tenant_id) WHERE state IN ('queued','running','interrupted');
CREATE INDEX woocommerce_sync_jobs_worker_idx
  ON woocommerce_sync_jobs(state, created_at) WHERE state IN ('queued','running','interrupted');
CREATE INDEX woocommerce_sync_jobs_tenant_history_idx
  ON woocommerce_sync_jobs(tenant_id, created_at DESC);

-- Woo stock is an observation, never an inventory balance. It is reconciled
-- only through an explicit, audited inventory movement command.
CREATE TABLE woocommerce_stock_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  catalog_item_id integer NOT NULL REFERENCES catalog_items(id),
  woo_product_id text NOT NULL,
  woo_variation_id text,
  stock_management text NOT NULL,
  managed_stock boolean NOT NULL,
  stock_quantity numeric(20,6),
  stock_status text,
  currency_code text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT woocommerce_stock_snapshots_management_check CHECK (stock_management IN ('independent','variation','shared_parent','unmanaged')),
  CONSTRAINT woocommerce_stock_snapshots_quantity_check CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  CONSTRAINT woocommerce_stock_snapshots_currency_check CHECK (currency_code ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX woocommerce_stock_snapshots_parent_unique
  ON woocommerce_stock_snapshots(tenant_id, woo_product_id) WHERE woo_variation_id IS NULL;
CREATE UNIQUE INDEX woocommerce_stock_snapshots_variation_unique
  ON woocommerce_stock_snapshots(tenant_id, woo_product_id, woo_variation_id) WHERE woo_variation_id IS NOT NULL;
CREATE INDEX woocommerce_stock_snapshots_item_idx
  ON woocommerce_stock_snapshots(tenant_id, catalog_item_id, observed_at DESC);

-- Woo stock is store-wide rather than location-specific. Bind each imported
-- catalogue item to one explicitly selected MyOrder location so the same
-- quantity cannot be imported into multiple locations.
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tenant_woo_stock_identity_idx ON catalog_items(tenant_id, id);
CREATE TABLE woocommerce_stock_location_assignments (
  tenant_id integer NOT NULL REFERENCES tenants(id),
  catalog_item_id integer NOT NULL,
  location_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, catalog_item_id),
  CONSTRAINT woocommerce_stock_assignment_item_fk FOREIGN KEY (tenant_id, catalog_item_id)
    REFERENCES catalog_items(tenant_id, id),
  CONSTRAINT woocommerce_stock_assignment_location_fk FOREIGN KEY (tenant_id, location_id)
    REFERENCES inventory_locations(tenant_id, id)
);

-- Parent Woo identity must be stable and unique within a tenant too.
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, woo_product_id FROM catalog_items
    WHERE woo_product_id IS NOT NULL AND woo_variation_id IS NULL
    GROUP BY tenant_id, woo_product_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Woo parent identities require controlled reconciliation';
  END IF;
END $$;
CREATE UNIQUE INDEX catalog_items_tenant_woo_parent_unique
  ON catalog_items(tenant_id, woo_product_id)
  WHERE woo_product_id IS NOT NULL AND woo_variation_id IS NULL;
