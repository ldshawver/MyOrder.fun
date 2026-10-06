-- Treat tenant slugs as case-insensitive identities. Refuse ambiguous legacy
-- rows before replacing the older exact-case unique constraint.
DO $$
DECLARE
  duplicate_summary text;
BEGIN
  SELECT string_agg(
    format('slug_key=%L tenant_ids=[%s]', slug_key, tenant_ids),
    '; ' ORDER BY slug_key
  )
  INTO duplicate_summary
  FROM (
    SELECT lower(slug) AS slug_key, string_agg(id::text, ',' ORDER BY id) AS tenant_ids
    FROM tenants
    GROUP BY lower(slug)
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant slug case-insensitive uniqueness preflight failed: %',
      duplicate_summary
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 0000 created this exact-case constraint. Remove it so the expression index
-- below is the single canonical slug uniqueness index.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_slug_unique;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_ci_unique_idx
  ON tenants (lower(slug));

-- IF NOT EXISTS must not silently accept an index with a different definition.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class index_class ON index_class.oid = i.indexrelid
    JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
    WHERE i.indrelid = 'public.tenants'::regclass
      AND index_schema.nspname = 'public'
      AND index_class.relname = 'tenants_slug_ci_unique_idx'
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnatts = 1 AND i.indnkeyatts = 1
      AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'lower(slug)'
  ) THEN
    RAISE EXCEPTION 'tenants_slug_ci_unique_idx does not enforce case-insensitive slug uniqueness'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
