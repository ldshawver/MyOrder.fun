-- Explicit grouping. Each legacy catalogue SKU remains its own product and
-- Standard option; no name based grouping is attempted.
CREATE TABLE catalogue_products (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  inventory_model text NOT NULL DEFAULT 'SEPARATE_VARIANTS' CHECK (inventory_model IN ('SHARED', 'SEPARATE_VARIANTS')),
  location_evaluation text NOT NULL DEFAULT 'PER_LOCATION' CHECK (location_evaluation IN ('PER_LOCATION', 'COMBINED_LOCATIONS')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE inventory_items (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  catalog_item_id integer NOT NULL,
  base_unit text NOT NULL DEFAULT 'each',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, catalog_item_id),
  FOREIGN KEY (tenant_id, catalog_item_id) REFERENCES catalog_items(tenant_id, id)
);
CREATE TABLE catalogue_options (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  product_id integer NOT NULL,
  catalog_item_id integer NOT NULL,
  inventory_item_id integer NOT NULL,
  label text NOT NULL DEFAULT 'Standard',
  consumption_quantity numeric(20, 6) NOT NULL DEFAULT 1 CHECK (consumption_quantity > 0),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, catalog_item_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalogue_products(tenant_id, id),
  FOREIGN KEY (tenant_id, catalog_item_id) REFERENCES catalog_items(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id)
);
CREATE INDEX catalogue_options_product_idx ON catalogue_options (tenant_id, product_id, sort_order, id);
CREATE TABLE inventory_reorder_policies (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  inventory_item_id integer NOT NULL,
  location_id integer NOT NULL REFERENCES inventory_locations(id),
  par numeric(20, 6) NOT NULL DEFAULT 0 CHECK (par >= 0),
  reorder_point numeric(20, 6) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  preferred_reorder_quantity numeric(20, 6) NOT NULL DEFAULT 0 CHECK (preferred_reorder_quantity >= 0),
  moq numeric(20, 6) NOT NULL DEFAULT 0 CHECK (moq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inventory_item_id, location_id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id)
);
ALTER TABLE order_items ADD COLUMN option_id integer;
ALTER TABLE order_items ADD COLUMN option_label_snapshot text;
ALTER TABLE order_items ADD COLUMN sku_snapshot text;
ALTER TABLE order_items ADD COLUMN inventory_item_id integer;
ALTER TABLE order_items ADD COLUMN inventory_quantity_snapshot numeric(20, 6);
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  catalog_item_id integer NOT NULL REFERENCES catalog_items(id),
  location_id integer NOT NULL REFERENCES inventory_locations(id),
  quantity numeric(20, 6) NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  idempotency_key text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory_reservations ADD COLUMN order_item_id integer REFERENCES order_items(id);
CREATE OR REPLACE FUNCTION block_live_inventory_model_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE moved boolean := false;
BEGIN
  IF OLD.inventory_model IS DISTINCT FROM NEW.inventory_model AND OLD.active THEN
    IF EXISTS (
      SELECT 1 FROM catalogue_options co
      JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
      WHERE co.tenant_id = OLD.tenant_id AND co.product_id = OLD.id
        AND (EXISTS (SELECT 1 FROM inventory_balances b WHERE b.tenant_id = OLD.tenant_id AND b.product_id = ii.catalog_item_id)
          OR EXISTS (SELECT 1 FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
            WHERE o.tenant_id = OLD.tenant_id AND r.catalog_item_id = ii.catalog_item_id)
          OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.tenant_id = OLD.tenant_id AND oi.catalog_item_id = co.catalog_item_id))
    ) THEN
      RAISE EXCEPTION 'Controlled reconciliation required to change active inventory model';
    END IF;
    IF to_regclass('inventory_transaction_log') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM catalogue_options co JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id JOIN inventory_transaction_log l ON l.catalog_item_id = ii.catalog_item_id WHERE co.tenant_id = $1 AND co.product_id = $2)'
        INTO moved USING OLD.tenant_id, OLD.id;
      IF moved THEN RAISE EXCEPTION 'Controlled reconciliation required to change active inventory model'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION create_standard_option_for_catalogue_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product_key integer; item_key integer;
BEGIN
  INSERT INTO catalogue_products (tenant_id, name) VALUES (NEW.tenant_id, NEW.name) RETURNING id INTO product_key;
  INSERT INTO inventory_items (tenant_id, catalog_item_id, base_unit)
    VALUES (NEW.tenant_id, NEW.id, COALESCE(NULLIF(NEW.stock_unit, '#'), 'each')) RETURNING id INTO item_key;
  INSERT INTO catalogue_options (tenant_id, product_id, catalog_item_id, inventory_item_id)
    VALUES (NEW.tenant_id, product_key, NEW.id, item_key);
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_item_standard_option AFTER INSERT ON catalog_items
FOR EACH ROW EXECUTE FUNCTION create_standard_option_for_catalogue_item();
CREATE TRIGGER catalogue_product_inventory_model_guard BEFORE UPDATE OF inventory_model ON catalogue_products
FOR EACH ROW EXECUTE FUNCTION block_live_inventory_model_change();
DO $$ DECLARE row record; product_key integer; item_key integer; BEGIN
  FOR row IN SELECT id, tenant_id, name, stock_unit FROM catalog_items ORDER BY id LOOP
    INSERT INTO catalogue_products (tenant_id, name) VALUES (row.tenant_id, row.name) RETURNING id INTO product_key;
    INSERT INTO inventory_items (tenant_id, catalog_item_id, base_unit)
      VALUES (row.tenant_id, row.id, COALESCE(NULLIF(row.stock_unit, '#'), 'each')) RETURNING id INTO item_key;
    INSERT INTO catalogue_options (tenant_id, product_id, catalog_item_id, inventory_item_id)
      VALUES (row.tenant_id, product_key, row.id, item_key);
  END LOOP;
END $$;
