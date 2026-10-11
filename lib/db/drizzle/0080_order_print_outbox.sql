ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name_snapshot text;

CREATE TABLE IF NOT EXISTS order_print_outbox (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  order_id integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  lease_owner text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_print_outbox_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_print_outbox_tenant_order_unique UNIQUE (tenant_id, order_id)
);

CREATE INDEX IF NOT EXISTS order_print_outbox_pending_idx
  ON order_print_outbox (next_attempt_at, id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS order_print_outbox_stale_claim_idx
  ON order_print_outbox (claimed_at) WHERE state = 'processing';
