ALTER TABLE "print_bridge_profiles"
  ADD COLUMN IF NOT EXISTS "last_printer_availability" text,
  ADD COLUMN IF NOT EXISTS "last_printer_reason" text,
  ADD COLUMN IF NOT EXISTS "last_printer_checked_at" timestamptz;

ALTER TABLE "print_bridge_profiles"
  DROP CONSTRAINT IF EXISTS "print_bridge_profiles_printer_availability_check";
ALTER TABLE "print_bridge_profiles"
  ADD CONSTRAINT "print_bridge_profiles_printer_availability_check"
  CHECK ("last_printer_availability" IS NULL OR "last_printer_availability" IN ('available', 'degraded', 'unavailable'));
