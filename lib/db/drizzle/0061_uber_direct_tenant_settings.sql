-- Tenant-owned Uber Direct configuration.  This is deliberately separate from
-- deployment environment variables so a tenant cannot inherit another tenant's
-- customer ID, credentials, webhook key, or dispatch switch.
CREATE TABLE IF NOT EXISTS "uber_direct_settings" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "enabled" boolean NOT NULL DEFAULT false,
  "environment" text NOT NULL DEFAULT 'sandbox' CHECK ("environment" IN ('sandbox', 'production')),
  "customer_id" text,
  "client_id" text,
  "client_secret_ciphertext" text,
  "webhook_signing_key_ciphertext" text,
  "pickup_location_id" integer,
  "dispatch_enabled" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uber_direct_settings_tenant_unique" UNIQUE ("tenant_id"),
  CONSTRAINT "uber_direct_settings_tenant_pickup_location_fk"
    FOREIGN KEY ("tenant_id", "pickup_location_id")
    REFERENCES "inventory_locations"("tenant_id", "id")
);
