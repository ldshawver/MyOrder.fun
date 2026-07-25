-- Add a canonical print_jobs.job_type column without breaking the currently
-- deployed application, which still writes the historical job_output column.
-- A stored generated column cannot drift and requires no trigger or backfill.
ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "job_type" text
  GENERATED ALWAYS AS ("job_output") STORED;

ALTER TABLE "print_jobs"
  ALTER COLUMN "job_type" SET NOT NULL;

ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_job_type_check";
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_job_type_check"
  CHECK ("job_type" IN (
    'order_ticket',
    'receipt',
    'label',
    'customer_receipt',
    'expo_ticket',
    'shift_start_receipt',
    'shift_end_receipt'
  )) NOT VALID;
ALTER TABLE "print_jobs"
  VALIDATE CONSTRAINT "print_jobs_job_type_check";

ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_status_check";
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_status_check"
  CHECK ("status" IN ('queued', 'sending', 'printed', 'retrying', 'failed')) NOT VALID;
ALTER TABLE "print_jobs"
  VALIDATE CONSTRAINT "print_jobs_status_check";

CREATE INDEX IF NOT EXISTS "print_jobs_status_created_idx"
  ON "print_jobs" ("status", "created_at");
