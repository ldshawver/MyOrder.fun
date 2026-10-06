-- Enforce one admin settings row per tenant. Stop with a clear error if legacy
-- data needs manual repair before this migration can run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_settings GROUP BY tenant_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'admin_settings has duplicate tenant_id rows; tenant uniqueness migration stopped'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS admin_settings_tenant_id_unique_idx
  ON admin_settings (tenant_id);

-- IF NOT EXISTS must not silently accept an unrelated or invalid index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class index_class ON index_class.oid = i.indexrelid
    JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
    JOIN pg_attribute tenant_column ON tenant_column.attrelid = i.indrelid
      AND tenant_column.attname = 'tenant_id'
    WHERE i.indrelid = 'public.admin_settings'::regclass
      AND index_schema.nspname = 'public'
      AND index_class.relname = 'admin_settings_tenant_id_unique_idx'
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnatts = 1 AND i.indnkeyatts = 1
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indkey[0] = tenant_column.attnum
  ) THEN
    RAISE EXCEPTION 'admin_settings_tenant_id_unique_idx does not enforce full tenant uniqueness'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
