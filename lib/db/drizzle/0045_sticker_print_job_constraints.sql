ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_job_type_check";
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_job_type_check"
  CHECK ("job_type" IN (
    'order_ticket', 'receipt', 'label', 'customer_receipt', 'expo_ticket',
    'shift_start_receipt', 'shift_end_receipt', 'thank_you_sticker'
  ));

ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_status_check";
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_status_check"
  CHECK ("status" IN (
    'queued', 'sending', 'printed', 'retrying', 'failed',
    'claimed', 'submitting', 'submitted', 'completed', 'rejected',
    'printer_unavailable', 'submission_failed', 'submission_unknown',
    'cups_failed', 'canceled', 'timed_out'
  ));
