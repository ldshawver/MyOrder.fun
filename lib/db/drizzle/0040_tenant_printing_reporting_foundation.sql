-- Tenant/location-scoped printing and immutable financial/closeout snapshots.
-- Backfills ownership only from existing authoritative relationships and aborts
-- if a legacy row cannot be attributed unambiguously.

ALTER TABLE "print_bridge_profiles" ADD COLUMN "tenant_id" integer;
ALTER TABLE "print_bridge_profiles" ADD COLUMN "location_id" integer;
ALTER TABLE "print_bridge_profiles" ADD COLUMN "routing_scope" text NOT NULL DEFAULT 'general';
ALTER TABLE "print_printers" ADD COLUMN "tenant_id" integer;
ALTER TABLE "print_printers" ADD COLUMN "location_id" integer;
ALTER TABLE "print_printers" ADD COLUMN "routing_scope" text NOT NULL DEFAULT 'general';
ALTER TABLE "operator_print_profiles" ADD COLUMN "tenant_id" integer;
ALTER TABLE "operator_print_profiles" ADD COLUMN "location_id" integer;
ALTER TABLE "operator_print_profiles" ADD COLUMN "shift_id" integer;
ALTER TABLE "operator_print_profiles" ADD COLUMN "expo_printer_id" integer;
ALTER TABLE "operator_print_profiles" ADD COLUMN "print_expo_tickets" boolean NOT NULL DEFAULT false;
ALTER TABLE "print_assets" ADD COLUMN "tenant_id" integer;
ALTER TABLE "print_assets" ADD COLUMN "content_sha256" text;
ALTER TABLE "print_assets" ADD COLUMN "width_px" integer;
ALTER TABLE "print_assets" ADD COLUMN "height_px" integer;
ALTER TABLE "print_assets" ADD COLUMN "created_by_user_id" integer;
ALTER TABLE "print_assets" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true;
ALTER TABLE "print_templates" ADD COLUMN "tenant_id" integer;
ALTER TABLE "print_templates" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "print_templates" ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "print_templates" ADD COLUMN "created_by_user_id" integer;
ALTER TABLE "print_jobs" ADD COLUMN "tenant_id" integer;
ALTER TABLE "print_jobs" ADD COLUMN "location_id" integer;
ALTER TABLE "print_jobs" ADD COLUMN "shift_id" integer;
ALTER TABLE "print_jobs" ADD COLUMN "template_id" integer;
ALTER TABLE "print_jobs" ADD COLUMN "template_version" integer;
ALTER TABLE "print_job_attempts" ADD COLUMN "tenant_id" integer;

UPDATE "operator_print_profiles" p
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE u."id" = p."user_id";

UPDATE "print_printers" p
SET "tenant_id" = ownership."tenant_id"
FROM (
  SELECT printer_id, min(tenant_id) AS tenant_id
  FROM (
    SELECT receipt_printer_id AS printer_id, tenant_id FROM operator_print_profiles WHERE receipt_printer_id IS NOT NULL
    UNION ALL SELECT label_printer_id, tenant_id FROM operator_print_profiles WHERE label_printer_id IS NOT NULL
    UNION ALL SELECT fallback_receipt_printer_id, tenant_id FROM operator_print_profiles WHERE fallback_receipt_printer_id IS NOT NULL
  ) refs
  GROUP BY printer_id
  HAVING count(DISTINCT tenant_id) = 1
) ownership
WHERE p.id = ownership.printer_id;

UPDATE "print_bridge_profiles" b
SET "tenant_id" = ownership."tenant_id"
FROM (
  SELECT bridge_profile_id, min(tenant_id) AS tenant_id
  FROM print_printers
  WHERE bridge_profile_id IS NOT NULL AND tenant_id IS NOT NULL
  GROUP BY bridge_profile_id
  HAVING count(DISTINCT tenant_id) = 1
) ownership
WHERE b.id = ownership.bridge_profile_id;

UPDATE "print_jobs" j SET "tenant_id" = o."tenant_id"
FROM "orders" o WHERE o.id = j.order_id;
UPDATE "print_jobs" j SET "tenant_id" = u."tenant_id"
FROM "users" u WHERE j.tenant_id IS NULL AND u.id = j.operator_user_id;
UPDATE "print_jobs" j SET "tenant_id" = p."tenant_id"
FROM "print_printers" p WHERE j.tenant_id IS NULL AND p.id = j.printer_id;
UPDATE "print_job_attempts" a SET "tenant_id" = j."tenant_id"
FROM "print_jobs" j WHERE j.id = a.print_job_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM print_bridge_profiles WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM print_printers WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM operator_print_profiles WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM print_assets WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM print_templates WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM print_jobs WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM print_job_attempts WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'printing ownership backfill is ambiguous; assign legacy rows before migration';
  END IF;
END $$;

ALTER TABLE "print_bridge_profiles" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_printers" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "operator_print_profiles" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_assets" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_templates" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_jobs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_job_attempts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "print_assets" ALTER COLUMN "content_sha256" SET NOT NULL;
ALTER TABLE "print_assets" ALTER COLUMN "width_px" SET NOT NULL;
ALTER TABLE "print_assets" ALTER COLUMN "height_px" SET NOT NULL;
ALTER TABLE "print_assets" ALTER COLUMN "created_by_user_id" SET NOT NULL;

ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_id_unique" UNIQUE (tenant_id, id);
ALTER TABLE "lab_tech_shifts" ADD CONSTRAINT "lab_tech_shifts_tenant_id_id_unique" UNIQUE (tenant_id, id);

ALTER TABLE "print_bridge_profiles" ADD CONSTRAINT "print_bridge_profiles_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "print_bridge_profiles" ADD CONSTRAINT "print_bridge_profiles_location_fk" FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id);
ALTER TABLE "print_bridge_profiles" ADD CONSTRAINT "print_bridge_profiles_scope_check" CHECK ((routing_scope = 'general' AND location_id IS NULL) OR (routing_scope = 'location' AND location_id IS NOT NULL));
ALTER TABLE "print_bridge_profiles" ADD CONSTRAINT "print_bridge_profiles_tenant_id_unique" UNIQUE (tenant_id, id);
ALTER TABLE "print_bridge_profiles" ADD CONSTRAINT "print_bridge_profiles_tenant_location_id_unique" UNIQUE (tenant_id, location_id, id);

ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_location_fk" FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id);
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_bridge_tenant_fk" FOREIGN KEY (tenant_id, bridge_profile_id) REFERENCES print_bridge_profiles(tenant_id, id);
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_bridge_location_fk" FOREIGN KEY (tenant_id, location_id, bridge_profile_id) REFERENCES print_bridge_profiles(tenant_id, location_id, id);
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_scope_check" CHECK ((routing_scope = 'general' AND location_id IS NULL) OR (routing_scope = 'location' AND location_id IS NOT NULL));
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_tenant_id_unique" UNIQUE (tenant_id, id);
ALTER TABLE "print_printers" ADD CONSTRAINT "print_printers_tenant_location_id_unique" UNIQUE (tenant_id, location_id, id);
CREATE UNIQUE INDEX "print_printers_tenant_bridge_queue_unique" ON print_printers(tenant_id, bridge_profile_id, bridge_printer_name) WHERE bridge_profile_id IS NOT NULL AND bridge_printer_name IS NOT NULL;

ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_user_tenant_fk" FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_location_fk" FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_shift_tenant_fk" FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_receipt_tenant_fk" FOREIGN KEY (tenant_id, receipt_printer_id) REFERENCES print_printers(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_label_tenant_fk" FOREIGN KEY (tenant_id, label_printer_id) REFERENCES print_printers(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_expo_tenant_fk" FOREIGN KEY (tenant_id, expo_printer_id) REFERENCES print_printers(tenant_id, id);
ALTER TABLE "operator_print_profiles" ADD CONSTRAINT "operator_print_profiles_no_fallback_check" CHECK (fallback_receipt_printer_id IS NULL);
CREATE UNIQUE INDEX "operator_print_profiles_tenant_user_scope_unique" ON operator_print_profiles(tenant_id, user_id, coalesce(location_id, 0), coalesce(shift_id, 0));

ALTER TABLE "print_assets" ADD CONSTRAINT "print_assets_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "print_assets" ADD CONSTRAINT "print_assets_creator_tenant_fk" FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id);
ALTER TABLE "print_assets" ADD CONSTRAINT "print_assets_raster_check" CHECK (mime_output IN ('image/png','image/jpeg','image/webp') AND size_bytes BETWEEN 1 AND 5242880 AND width_px BETWEEN 1 AND 4096 AND height_px BETWEEN 1 AND 4096 AND storage_path !~ '(^/|\.\.)');
ALTER TABLE "print_assets" ADD CONSTRAINT "print_assets_tenant_id_unique" UNIQUE (tenant_id, id);
CREATE UNIQUE INDEX "print_assets_tenant_hash_unique" ON print_assets(tenant_id, content_sha256) WHERE content_sha256 IS NOT NULL;

ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_asset_tenant_fk" FOREIGN KEY (tenant_id, background_asset_id) REFERENCES print_assets(tenant_id, id);
ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_creator_tenant_fk" FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id);
ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_version_check" CHECK (version > 0 AND schema_version = 1 AND jsonb_typeof(template_json) = 'array');
ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_tenant_id_unique" UNIQUE (tenant_id, id);
CREATE UNIQUE INDEX "print_templates_one_default_per_type" ON print_templates(tenant_id, job_output) WHERE is_default AND is_active;

CREATE TABLE "print_template_versions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES tenants(id),
  "template_id" integer NOT NULL,
  "version" integer NOT NULL CHECK (version > 0),
  "schema_version" integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  "template_json" jsonb NOT NULL CHECK (jsonb_typeof(template_json) = 'array'),
  "background_asset_id" integer,
  "paper_width" text NOT NULL,
  "paper_height" text NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_id, version),
  FOREIGN KEY (tenant_id, template_id) REFERENCES print_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, background_asset_id) REFERENCES print_assets(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id)
);

ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_tenant_fk" FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_tenant_fk" FOREIGN KEY (tenant_id, printer_id) REFERENCES print_printers(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_operator_tenant_fk" FOREIGN KEY (tenant_id, operator_user_id) REFERENCES users(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_location_fk" FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shift_tenant_fk" FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_template_tenant_fk" FOREIGN KEY (tenant_id, template_id) REFERENCES print_templates(tenant_id, id);
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_unique" UNIQUE (tenant_id, id);
ALTER TABLE "print_job_attempts" ADD CONSTRAINT "print_job_attempts_job_tenant_fk" FOREIGN KEY (tenant_id, print_job_id) REFERENCES print_jobs(tenant_id, id);

CREATE TABLE "shift_print_assignments" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES tenants(id),
  "shift_id" integer NOT NULL,
  "location_id" integer NOT NULL,
  "receipt_printer_id" integer,
  "expo_printer_id" integer,
  "print_expo_tickets" boolean NOT NULL DEFAULT false,
  "assigned_by_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shift_id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id, receipt_printer_id) REFERENCES print_printers(tenant_id, location_id, id),
  FOREIGN KEY (tenant_id, location_id, expo_printer_id) REFERENCES print_printers(tenant_id, location_id, id),
  FOREIGN KEY (tenant_id, assigned_by_user_id) REFERENCES users(tenant_id, id),
  CHECK (NOT print_expo_tickets OR expo_printer_id IS NOT NULL)
);

ALTER TABLE "orders" ADD COLUMN "tax_snapshot" jsonb;
ALTER TABLE "orders" ADD COLUMN "cash_discount_snapshot" jsonb;
CREATE TABLE "order_tax_snapshots" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES tenants(id),
  "order_id" integer NOT NULL,
  "jurisdiction" text,
  "tax_rate" numeric(9,8) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 1),
  "taxable_subtotal" numeric(12,2) NOT NULL CHECK (taxable_subtotal >= 0),
  "non_taxable_subtotal" numeric(12,2) NOT NULL DEFAULT 0 CHECK (non_taxable_subtotal >= 0),
  "discount_amount" numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  "cash_discount_amount" numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_discount_amount >= 0),
  "tax_collected" numeric(12,2) NOT NULL CHECK (tax_collected >= 0),
  "tender" text,
  "exemption_reason" text,
  "snapshot_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

ALTER TABLE "admin_settings" ADD COLUMN "cash_discount_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "admin_settings" ADD COLUMN "cash_discount_type" text NOT NULL DEFAULT 'percentage';
ALTER TABLE "admin_settings" ADD COLUMN "cash_discount_value" numeric(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_cash_discount_check" CHECK (cash_discount_type IN ('percentage','fixed') AND cash_discount_value >= 0);

CREATE TABLE "shift_closeout_packages" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES tenants(id),
  "shift_id" integer NOT NULL,
  "location_id" integer,
  "supervisor_user_id" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "snapshot_json" jsonb NOT NULL,
  "source_max_updated_at" timestamptz NOT NULL,
  "closed_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shift_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id),
  FOREIGN KEY (tenant_id, supervisor_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE "commission_snapshots" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES tenants(id),
  "closeout_package_id" integer NOT NULL,
  "shift_id" integer NOT NULL,
  "csr_user_id" integer NOT NULL,
  "qualifying_sales" numeric(12,2) NOT NULL,
  "commission_basis" numeric(12,2) NOT NULL,
  "commission_rate" numeric(9,6) NOT NULL,
  "adjustments" numeric(12,2) NOT NULL DEFAULT 0,
  "commission_amount" numeric(12,2) NOT NULL,
  "rule_snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, closeout_package_id, csr_user_id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES lab_tech_shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, csr_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (closeout_package_id) REFERENCES shift_closeout_packages(id)
);

CREATE OR REPLACE FUNCTION reject_immutable_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER print_template_versions_immutable BEFORE UPDATE OR DELETE ON print_template_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
CREATE TRIGGER order_tax_snapshots_immutable BEFORE UPDATE OR DELETE ON order_tax_snapshots FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
CREATE TRIGGER shift_closeout_packages_immutable BEFORE UPDATE OR DELETE ON shift_closeout_packages FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();
CREATE TRIGGER commission_snapshots_immutable BEFORE UPDATE OR DELETE ON commission_snapshots FOR EACH ROW EXECUTE FUNCTION reject_immutable_snapshot_mutation();

CREATE INDEX "print_jobs_tenant_location_status_idx" ON print_jobs(tenant_id, location_id, status);
CREATE INDEX "print_printers_tenant_location_role_idx" ON print_printers(tenant_id, location_id, role) WHERE is_active;
CREATE INDEX "print_job_attempts_tenant_job_idx" ON print_job_attempts(tenant_id, print_job_id);
