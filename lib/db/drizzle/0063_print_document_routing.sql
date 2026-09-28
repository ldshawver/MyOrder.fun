-- Printer classes and document routing.
--
-- 1. Every registered printer is either a thermal receipt printer (50mm or
--    80mm roll) or a full-page (US Letter) printer. Existing printers are
--    thermal, which is what they are today.
-- 2. print_routes maps (tenant, location, document type) to exactly one
--    registered printer. A NULL location is the tenant-wide default for that
--    document type; at most one exists per tenant and document type.
--
-- Additive only: no printer, route or automatic-print setting is enabled.
ALTER TABLE "print_printers"
  ADD COLUMN IF NOT EXISTS "printer_class" text NOT NULL DEFAULT 'thermal';

DO $$ BEGIN
  ALTER TABLE "print_printers"
    ADD CONSTRAINT "print_printers_printer_class_check" CHECK ("printer_class" IN ('thermal', 'full_page'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "print_routes" ALTER COLUMN "location_id" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "print_routes_tenant_default_job_uq"
  ON "print_routes" ("tenant_id", "job_type")
  WHERE "location_id" IS NULL;
