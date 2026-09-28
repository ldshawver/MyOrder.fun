-- Tenant-owned automatic-print controls.
--
-- Replaces the single global print_settings.auto_print_* flags as the
-- authoritative switch, so an admin of one tenant can never turn automatic
-- printing on or off for another tenant.
--
-- Safety: this migration performs NO backfill. A tenant without a row has
-- automatic order, receipt and label printing OFF, and every column defaults
-- to false. Applying it can therefore never enable printing. The legacy
-- global columns are left in place (unread) for one release and dropped by a
-- later migration.
CREATE TABLE IF NOT EXISTS "tenant_print_controls" (
  "tenant_id" integer PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "auto_print_orders" boolean NOT NULL DEFAULT false,
  "auto_print_receipts" boolean NOT NULL DEFAULT false,
  "auto_print_labels" boolean NOT NULL DEFAULT false,
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "tenant_print_controls_version_positive" CHECK ("version" > 0)
);
