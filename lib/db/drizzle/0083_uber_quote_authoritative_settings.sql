-- Add the tenant-owned, non-secret values required to construct an Uber Direct
-- quote from authoritative store data. Existing tenants remain incomplete and
-- fail closed until an administrator supplies every value.
ALTER TABLE "uber_direct_settings"
  ADD COLUMN IF NOT EXISTS "pickup_latitude" numeric(9,6),
  ADD COLUMN IF NOT EXISTS "pickup_longitude" numeric(9,6),
  ADD COLUMN IF NOT EXISTS "external_store_id" text,
  ADD COLUMN IF NOT EXISTS "pickup_window_minutes" integer,
  ADD COLUMN IF NOT EXISTS "dropoff_window_minutes" integer;

ALTER TABLE "uber_direct_settings"
  DROP CONSTRAINT IF EXISTS "uber_direct_settings_pickup_latitude_check",
  ADD CONSTRAINT "uber_direct_settings_pickup_latitude_check"
    CHECK ("pickup_latitude" IS NULL OR ("pickup_latitude" >= -90 AND "pickup_latitude" <= 90)),
  DROP CONSTRAINT IF EXISTS "uber_direct_settings_pickup_longitude_check",
  ADD CONSTRAINT "uber_direct_settings_pickup_longitude_check"
    CHECK ("pickup_longitude" IS NULL OR ("pickup_longitude" >= -180 AND "pickup_longitude" <= 180)),
  DROP CONSTRAINT IF EXISTS "uber_direct_settings_pickup_window_check",
  ADD CONSTRAINT "uber_direct_settings_pickup_window_check"
    CHECK ("pickup_window_minutes" IS NULL OR ("pickup_window_minutes" >= 5 AND "pickup_window_minutes" <= 240)),
  DROP CONSTRAINT IF EXISTS "uber_direct_settings_dropoff_window_check",
  ADD CONSTRAINT "uber_direct_settings_dropoff_window_check"
    CHECK ("dropoff_window_minutes" IS NULL OR ("dropoff_window_minutes" >= 15 AND "dropoff_window_minutes" <= 480));

ALTER TABLE "uber_delivery_quotes"
  ADD COLUMN IF NOT EXISTS "pickup_location_id" integer,
  ADD COLUMN IF NOT EXISTS "pickup_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "pickup_schedule_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "manifest_total_value" integer,
  ADD COLUMN IF NOT EXISTS "external_store_id" text;

ALTER TABLE "uber_delivery_quotes"
  DROP CONSTRAINT IF EXISTS "uber_delivery_quotes_tenant_pickup_location_fk",
  ADD CONSTRAINT "uber_delivery_quotes_tenant_pickup_location_fk"
    FOREIGN KEY ("tenant_id", "pickup_location_id")
    REFERENCES "inventory_locations"("tenant_id", "id");
