ALTER TABLE "print_bridge_profiles"
  ADD COLUMN IF NOT EXISTS "bridge_id" text,
  ADD COLUMN IF NOT EXISTS "environment" text NOT NULL DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS "allowed_job_type" text,
  ADD COLUMN IF NOT EXISTS "credential_hash" text,
  ADD COLUMN IF NOT EXISTS "bridge_version" text,
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS "print_bridge_profiles_bridge_id_uq" ON "print_bridge_profiles" ("bridge_id") WHERE "bridge_id" IS NOT NULL;

ALTER TABLE "print_printers"
  ADD COLUMN IF NOT EXISTS "expected_device_uri_hash" text,
  ADD COLUMN IF NOT EXISTS "receipt_capable" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "label_capable" boolean NOT NULL DEFAULT true;

CREATE TABLE "print_routes" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "location_id" integer NOT NULL,
  "job_type" text NOT NULL,
  "bridge_profile_id" integer NOT NULL,
  "printer_id" integer NOT NULL,
  "is_active" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "location_id", "job_type"),
  FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "bridge_profile_id") REFERENCES "print_bridge_profiles"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "print_printers"("tenant_id", "id"),
  CHECK ("job_type" = 'thank_you_sticker')
);

ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "bridge_profile_id" integer,
  ADD COLUMN IF NOT EXISTS "approval_state" text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "submitting_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "cups_job_id" integer,
  ADD COLUMN IF NOT EXISTS "cups_request_id" text,
  ADD COLUMN IF NOT EXISTS "final_cups_state" text,
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "failure_reason" text,
  ADD COLUMN IF NOT EXISTS "copy_count" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "media" text,
  ADD COLUMN IF NOT EXISTS "resolution" text,
  ADD COLUMN IF NOT EXISTS "bridge_version" text,
  ADD COLUMN IF NOT EXISTS "submission_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_bridge_tenant_fk" FOREIGN KEY ("tenant_id", "bridge_profile_id") REFERENCES "print_bridge_profiles"("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_single_cups_request_uq" ON "print_jobs" ("bridge_profile_id", "cups_request_id") WHERE "cups_request_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "print_jobs_bridge_claim_idx" ON "print_jobs" ("bridge_profile_id", "status", "created_at");
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_sticker_copy_check" CHECK ("job_output" <> 'thank_you_sticker' OR "copy_count" = 1),
  ADD CONSTRAINT "print_jobs_sticker_retry_check" CHECK ("job_output" <> 'thank_you_sticker' OR "max_retries" = 1),
  ADD CONSTRAINT "print_jobs_approval_state_check" CHECK ("approval_state" IN ('not_required','pending','approved','consumed'));
