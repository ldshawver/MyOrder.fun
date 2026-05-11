-- Migration 0007: simplified printer settings (Task #9).
--
-- Adds eight focused columns onto print_settings so the admin UI can offer two
-- clear modes — local CUPS (lp -d <queue>) and the Tailscale Print Bridge —
-- without dragging in the legacy bridge profiles, operator profiles, etc.
--
-- Existing extended fields (autoPrintOrders, autoPrintReceipts, paperWidth,
-- includeLogo, ...) are kept untouched; the new admin surface only reads/writes
-- the eight columns below. autoPrintReceipts already exists, so the eighth slot
-- is `last_test_result` which stores the most recent test summary.

ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "receipt_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "receipt_method" text NOT NULL DEFAULT 'local_cups';
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "receipt_printer_name" text NOT NULL DEFAULT 'receipt';
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "label_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "label_method" text NOT NULL DEFAULT 'local_cups';
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "label_printer_name" text NOT NULL DEFAULT 'label';
ALTER TABLE "print_settings" ADD COLUMN IF NOT EXISTS "last_test_result" jsonb;

-- Best-effort migration from any legacy printers row that named a "receipt" or
-- "label" bridge queue, so admins don't have to re-enter their queue names.
UPDATE "print_settings" ps
SET "receipt_printer_name" = COALESCE(
  (SELECT pp.bridge_printer_name FROM "print_printers" pp
   WHERE pp.role = 'receipt' AND pp.is_active = true
   ORDER BY pp.id ASC LIMIT 1),
  ps."receipt_printer_name"
)
WHERE ps."receipt_printer_name" = 'receipt';

UPDATE "print_settings" ps
SET "label_printer_name" = COALESCE(
  (SELECT pp.bridge_printer_name FROM "print_printers" pp
   WHERE pp.role = 'label' AND pp.is_active = true
   ORDER BY pp.id ASC LIMIT 1),
  ps."label_printer_name"
)
WHERE ps."label_printer_name" = 'label';
