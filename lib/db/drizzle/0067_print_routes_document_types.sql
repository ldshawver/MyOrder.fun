-- Document routes need their document types in print_routes.job_type.
--
-- 0044 created print_routes for staging sticker routes only
-- (CHECK job_type = 'thank_you_sticker'); 0063 added document routing but
-- left that check in place, so no document route could be stored. The check
-- now allows the sticker route and exactly the eight document types.
--
-- No rows are added or changed.
ALTER TABLE "print_routes" DROP CONSTRAINT IF EXISTS "print_routes_job_type_check";

ALTER TABLE "print_routes"
  ADD CONSTRAINT "print_routes_job_type_check" CHECK ("job_type" IN (
    'thank_you_sticker',
    'ORDER_RECEIPT', 'CLOCK_IN', 'CLOCK_OUT', 'INVENTORY_STOCK_LIST',
    'DEPOSIT', 'EXPO', 'WORK', 'REPORT'
  ));
