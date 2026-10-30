CREATE TABLE "location_pickup_schedules" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL,
  "time_zone" text NOT NULL,
  "weekly_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "slot_minutes" integer DEFAULT 30 NOT NULL,
  "max_advance_days" integer DEFAULT 14 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "location_pickup_schedules_tenant_location_unique" UNIQUE("tenant_id", "location_id"),
  CONSTRAINT "location_pickup_schedules_tenant_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "location_pickup_schedules_slot_minutes_check" CHECK ("slot_minutes" IN (10, 15, 20, 30, 45, 60)),
  CONSTRAINT "location_pickup_schedules_max_advance_days_check" CHECK ("max_advance_days" BETWEEN 1 AND 90),
  CONSTRAINT "location_pickup_schedules_version_check" CHECK ("version" > 0)
);

ALTER TABLE "orders" ADD COLUMN "pickup_location_id" integer;
ALTER TABLE "orders" ADD COLUMN "pickup_at" timestamp with time zone;
ALTER TABLE "orders" ADD COLUMN "pickup_schedule_snapshot" jsonb;
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_pickup_location_fk" FOREIGN KEY ("tenant_id", "pickup_location_id") REFERENCES "inventory_locations"("tenant_id", "id");
