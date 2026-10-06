ALTER TABLE "sales_tax_reporting_periods"
  ADD COLUMN IF NOT EXISTS "paid_amount" numeric(12,2);
