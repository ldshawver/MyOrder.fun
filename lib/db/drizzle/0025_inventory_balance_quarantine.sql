-- Explicit inventory balance classification and quarantine metadata.
-- Sellable rows must remain joined to tenant catalog products and active locations;
-- non-sellable/quarantined rows are report-only and excluded from sellable stock snapshots.
ALTER TABLE "inventory_balances"
  ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable_catalog',
  ADD COLUMN IF NOT EXISTS "quarantine_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "quarantine_reason" text;

UPDATE "inventory_balances"
SET
  "inventory_kind" = COALESCE(NULLIF("inventory_kind", ''), 'sellable_catalog'),
  "quarantine_status" = COALESCE(NULLIF("quarantine_status", ''), 'active');
