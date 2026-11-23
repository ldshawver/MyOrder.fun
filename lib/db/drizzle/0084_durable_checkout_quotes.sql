-- Durable, tenant/customer-scoped checkout quote authority. The opaque ID is
-- safe to return to the browser; prices and tax inputs remain in PostgreSQL
-- and each quote can be consumed by at most one order transaction.
CREATE TABLE IF NOT EXISTS "checkout_quotes" (
  "id" text PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "customer_id" integer NOT NULL REFERENCES "users"("id"),
  "cart_fingerprint" text NOT NULL,
  "location_id" integer,
  "tax_configuration_id" integer NOT NULL,
  "quote_snapshot" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'quoted',
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "checkout_quotes_status_check" CHECK ("status" IN ('quoted', 'consumed'))
);

CREATE INDEX IF NOT EXISTS "checkout_quotes_checkout_lookup_idx"
  ON "checkout_quotes" ("tenant_id", "customer_id", "status", "expires_at");
