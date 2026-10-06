CREATE TABLE IF NOT EXISTS return_transactions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id),
  order_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
  tender_type TEXT NOT NULL CHECK (tender_type IN ('customer_credit','cash','paypal')),
  refund_amount NUMERIC(12,2) NOT NULL CHECK (refund_amount > 0),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT return_transactions_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  CONSTRAINT return_transactions_actor_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT return_transactions_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id),
  CONSTRAINT return_transactions_tenant_key_unique UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS return_transactions_order_idx ON return_transactions (tenant_id, order_id, created_at);

CREATE TABLE IF NOT EXISTS return_lines (
  id SERIAL PRIMARY KEY,
  return_transaction_id INTEGER NOT NULL REFERENCES return_transactions(id),
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_value NUMERIC(12,2) NOT NULL CHECK (unit_value >= 0),
  tax_value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_value >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('RESTOCK','DO_NOT_RESTOCK')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT return_lines_transaction_item_unique UNIQUE (return_transaction_id, order_item_id)
);
CREATE INDEX IF NOT EXISTS return_lines_item_idx ON return_lines (order_item_id, created_at);
