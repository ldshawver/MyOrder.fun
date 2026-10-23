CREATE TABLE inventory_history_baseline_repair_events (
  id uuid PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  product_id integer NOT NULL,
  actor_user_id integer NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  preview_fingerprint text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  finalized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalogue_products(tenant_id, id)
);

CREATE OR REPLACE FUNCTION prevent_inventory_history_baseline_repair_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory history baseline repair evidence is immutable';
END $$;

CREATE TRIGGER inventory_history_baseline_repair_events_immutable
  BEFORE UPDATE OR DELETE ON inventory_history_baseline_repair_events
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_history_baseline_repair_mutation();
