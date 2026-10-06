-- Document print jobs need their job types in print_jobs.job_type.
--
-- print_jobs.job_type (generated from job_output) is limited by
-- print_jobs_job_type_check, last set in 0045 to the legacy receipt, label,
-- ticket and sticker values. Document printing (0063) writes clock, deposit,
-- inventory, report and test-print jobs, which the check rejected, so every
-- one of those inserts failed. The check now allows the legacy values plus the
-- job types of the document catalogue and the admin test print.
--
-- No rows are added or changed.
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_job_type_check";

ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_job_type_check" CHECK ("job_type" IN (
    'order_ticket', 'receipt', 'label', 'customer_receipt', 'expo_ticket',
    'shift_start_receipt', 'shift_end_receipt', 'thank_you_sticker',
    'receipt_template_test', 'document_test',
    'shift_clock_in', 'shift_clock_out', 'shift_deposit',
    'shift_beginning_inventory', 'shift_ending_inventory', 'shift_restock', 'inventory_stock_list',
    'shift_sales', 'shift_commission', 'report'
  ));
