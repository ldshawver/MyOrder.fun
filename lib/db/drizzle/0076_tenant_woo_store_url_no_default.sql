ALTER TABLE admin_settings
  ALTER COLUMN wc_store_url DROP DEFAULT;

ALTER TABLE admin_settings
  ADD COLUMN wc_webhook_secret text;

CREATE TABLE woocommerce_webhook_events (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  delivery_id text NOT NULL,
  topic text NOT NULL,
  product_id text NOT NULL,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  attempt_count integer NOT NULL DEFAULT 1,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT woocommerce_webhook_events_status_check CHECK (status IN ('processing','processed','failed')),
  CONSTRAINT woocommerce_webhook_events_tenant_delivery_unique UNIQUE (tenant_id, delivery_id)
);
