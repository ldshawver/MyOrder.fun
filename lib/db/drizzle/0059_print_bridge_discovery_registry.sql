-- Centralized bridge-owned physical-printer discovery and assignment.
-- Discovery never deletes rows: an unavailable device remains configurable.
ALTER TABLE "print_bridge_profiles"
  ADD COLUMN IF NOT EXISTS "last_discovery_at" timestamptz;

ALTER TABLE "print_printers"
  ADD COLUMN IF NOT EXISTS "stable_device_id" text,
  ADD COLUMN IF NOT EXISTS "system_name" text,
  ADD COLUMN IF NOT EXISTS "device_connection_type" text NOT NULL DEFAULT 'usb',
  ADD COLUMN IF NOT EXISTS "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "is_online" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "print_printers_tenant_bridge_stable_device_unique"
  ON "print_printers" ("tenant_id", "bridge_profile_id", "stable_device_id")
  WHERE "bridge_profile_id" IS NOT NULL AND "stable_device_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "print_printer_assignments" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "printer_id" integer NOT NULL,
  "job_type" text NOT NULL,
  "assigned_by_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "print_printer_assignments_tenant_printer_fk"
    FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "print_printers"("tenant_id", "id"),
  CONSTRAINT "print_printer_assignments_tenant_actor_fk"
    FOREIGN KEY ("tenant_id", "assigned_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "print_printer_assignments_job_type_check"
    CHECK ("job_type" IN ('customer_receipt', 'expo_ticket', 'label', 'thank_you_sticker')),
  CONSTRAINT "print_printer_assignments_tenant_printer_job_unique"
    UNIQUE ("tenant_id", "printer_id", "job_type")
);
CREATE INDEX IF NOT EXISTS "print_printer_assignments_tenant_job_idx"
  ON "print_printer_assignments" ("tenant_id", "job_type");
