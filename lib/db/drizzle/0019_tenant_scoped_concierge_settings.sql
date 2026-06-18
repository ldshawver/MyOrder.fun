-- Ensure concierge/admin settings are persisted per tenant instead of relying on
-- a process-local singleton row. The unique index prevents ambiguous reads and
-- accidental duplicate settings rows for the same tenant.
--
-- Preflight first so deploys fail with a clear error before attempting to
-- create the unique index on production databases that already have duplicates.
DO $$
DECLARE
  duplicate_summary text;
BEGIN
  SELECT string_agg(
    format('tenant_id=%s rows=%s ids=[%s]', tenant_id, row_count, ids),
    '; ' ORDER BY tenant_id
  )
  INTO duplicate_summary
  FROM (
    SELECT
      tenant_id,
      count(*) AS row_count,
      string_agg(id::text, ',' ORDER BY id) AS ids
    FROM "admin_settings"
    GROUP BY tenant_id
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight failed: admin_settings contains duplicate tenant_id rows. Resolve duplicates before applying admin_settings_tenant_id_unique_idx. %',
      duplicate_summary
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "concierge_intro_steps" text,
  ADD COLUMN IF NOT EXISTS "concierge_promoted_item_ids" text;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_settings_tenant_id_unique_idx"
  ON "admin_settings" ("tenant_id");
