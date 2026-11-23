-- Durable carrier-rate authority for Lucifer Direct checkout. Provider
-- adapters, not browsers, create these immutable price/service snapshots.
CREATE TABLE IF NOT EXISTS "carrier_quotes" (
  "id" text PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "customer_id" integer NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL,
  "provider_quote_id" text NOT NULL,
  "service_snapshot" jsonb NOT NULL,
  "destination_snapshot" jsonb NOT NULL,
  "cart_fingerprint" text NOT NULL,
  "fee_cents" integer NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'quoted',
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "carrier_quotes_tenant_provider_quote_unique" UNIQUE ("tenant_id", "provider", "provider_quote_id"),
  CONSTRAINT "carrier_quotes_fee_check" CHECK ("fee_cents" >= 0),
  CONSTRAINT "carrier_quotes_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "carrier_quotes_status_check" CHECK ("status" IN ('quoted', 'consumed'))
);

CREATE INDEX IF NOT EXISTS "carrier_quotes_checkout_lookup_idx"
  ON "carrier_quotes" ("tenant_id", "customer_id", "status", "expires_at");
