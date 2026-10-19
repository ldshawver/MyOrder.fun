CREATE TABLE catalogue_inventory_reconciliation_events (
  id uuid PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  product_id integer NOT NULL,
  actor_user_id integer NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  reverses_event_id uuid REFERENCES catalogue_inventory_reconciliation_events(id),
  preview_fingerprint text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (reverses_event_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalogue_products(tenant_id, id)
);

CREATE OR REPLACE FUNCTION prevent_catalogue_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.finalized_at IS NULL AND NEW.finalized_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.product_id = OLD.product_id
     AND NEW.actor_user_id = OLD.actor_user_id AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.reverses_event_id IS NOT DISTINCT FROM OLD.reverses_event_id
     AND NEW.preview_fingerprint = OLD.preview_fingerprint AND NEW.reason = OLD.reason
     AND NEW.created_at = OLD.created_at
     AND current_setting('myorder.catalogue_inventory_reconciliation_id', true) = OLD.id::text THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'catalogue reconciliation evidence is immutable';
END $$;
CREATE TRIGGER catalogue_inventory_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON catalogue_inventory_reconciliation_events
  FOR EACH ROW EXECUTE FUNCTION prevent_catalogue_reconciliation_mutation();

CREATE OR REPLACE FUNCTION block_live_inventory_model_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE moved boolean := false; reconciliation_id text;
BEGIN
  IF OLD.inventory_model IS DISTINCT FROM NEW.inventory_model AND OLD.active THEN
    reconciliation_id := current_setting('myorder.catalogue_inventory_reconciliation_id', true);
    IF reconciliation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM catalogue_inventory_reconciliation_events e
      WHERE e.id::text = reconciliation_id AND e.tenant_id = OLD.tenant_id AND e.product_id = OLD.id
        AND ((NEW.inventory_model = 'SHARED' AND e.evidence->>'operation' IS DISTINCT FROM 'rollback')
          OR (NEW.inventory_model = 'SEPARATE_VARIANTS' AND e.evidence->>'operation' = 'rollback'))
    ) THEN
      RETURN NEW;
    END IF;
    IF EXISTS (
      SELECT 1 FROM catalogue_options co
      JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
      WHERE co.tenant_id = OLD.tenant_id AND co.product_id = OLD.id
        AND (EXISTS (SELECT 1 FROM inventory_balances b WHERE b.tenant_id = OLD.tenant_id AND b.product_id = ii.catalog_item_id)
          OR EXISTS (SELECT 1 FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
            WHERE o.tenant_id = OLD.tenant_id AND r.catalog_item_id = ii.catalog_item_id)
          OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.tenant_id = OLD.tenant_id AND oi.catalog_item_id = co.catalog_item_id))
    ) THEN RAISE EXCEPTION 'Controlled reconciliation required to change active inventory model'; END IF;
    IF to_regclass('inventory_transaction_log') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM catalogue_options co JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id JOIN inventory_transaction_log l ON l.catalog_item_id = ii.catalog_item_id WHERE co.tenant_id = $1 AND co.product_id = $2)'
        INTO moved USING OLD.tenant_id, OLD.id;
      IF moved THEN RAISE EXCEPTION 'Controlled reconciliation required to change active inventory model'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
