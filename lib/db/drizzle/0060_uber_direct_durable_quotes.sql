-- Durable, tenant-scoped Uber Direct quote records. Browser-provided fees and
-- provider IDs are never financial authority; checkout consumes this record.
CREATE TABLE IF NOT EXISTS "uber_delivery_quotes" (
  "id" text PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "customer_id" integer NOT NULL REFERENCES "users"("id"),
  "provider_quote_id" text NOT NULL,
  "cart_fingerprint" text NOT NULL,
  "pickup_address" jsonb NOT NULL,
  "dropoff_address" jsonb NOT NULL,
  "manifest_items" jsonb NOT NULL,
  "fee_cents" integer NOT NULL CHECK ("fee_cents" >= 0),
  "currency" text NOT NULL,
  "provider_created_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'quoted',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "uber_delivery_quotes_checkout_lookup_idx"
  ON "uber_delivery_quotes" ("tenant_id", "customer_id", "status", "expires_at");

-- A durable, one-per-order handoff record. Dispatch is intentionally a later
-- post-payment action; a payment retry must reuse this same identity.
CREATE TABLE IF NOT EXISTS "uber_delivery_fulfillments" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL,
  "quote_id" text NOT NULL REFERENCES "uber_delivery_quotes"("id"),
  "external_order_reference" text NOT NULL,
  "provider_delivery_id" text,
  "provider_status" text,
  "request_state" text NOT NULL DEFAULT 'delivery_create_pending',
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "last_sanitized_error" text,
  "last_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uber_delivery_fulfillments_tenant_order_fk"
    FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id"),
  CONSTRAINT "uber_delivery_fulfillments_tenant_order_unique" UNIQUE ("tenant_id", "order_id"),
  CONSTRAINT "uber_delivery_fulfillments_external_reference_unique" UNIQUE ("external_order_reference"),
  CONSTRAINT "uber_delivery_fulfillments_provider_delivery_unique" UNIQUE ("provider_delivery_id")
);

CREATE TABLE IF NOT EXISTS "uber_delivery_webhook_events" (
  "id" bigserial PRIMARY KEY,
  "provider_event_id" text NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "tenant_id" integer REFERENCES "tenants"("id"),
  "fulfillment_id" bigint REFERENCES "uber_delivery_fulfillments"("id"),
  "provider_delivery_id" text,
  "provider_status" text,
  "event_time" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz
);
