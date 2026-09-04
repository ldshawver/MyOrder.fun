-- Tenant-wide customer digital-payment tax configuration.
-- Legacy location/sourcing rows remain available for reporting, but checkout
-- resolves only rows explicitly marked as tenant-wide.

ALTER TABLE "tax_configurations"
  ALTER COLUMN "location_id" DROP NOT NULL;

ALTER TABLE "tax_configurations"
  DROP CONSTRAINT IF EXISTS "tax_configurations_sourcing_rule_check";

ALTER TABLE "tax_configurations"
  ADD CONSTRAINT "tax_configurations_sourcing_rule_check"
  CHECK ("sourcing_rule" IN ('tenant','origin','destination','pickup'));

CREATE INDEX "tax_configurations_tenant_effective_idx"
  ON "tax_configurations" ("tenant_id", "effective_from", "effective_until")
  WHERE "sourcing_rule" = 'tenant' AND "location_id" IS NULL;
