\set ON_ERROR_STOP on
BEGIN READ ONLY;

DO $$
DECLARE
  missing_column text;
BEGIN
  SELECT expected.column_name
  INTO missing_column
  FROM (VALUES
    ('orders', 'prepared_at'),
    ('orders', 'prepared_by_user_id'),
    ('orders', 'assigned_shift_id'),
    ('orders', 'assigned_csr_user_id'),
    ('orders', 'routing_status'),
    ('orders', 'routing_strategy'),
    ('orders', 'routing_message'),
    ('orders', 'route_source'),
    ('orders', 'routed_to'),
    ('orders', 'routed_at'),
    ('orders', 'accepted_at'),
    ('orders', 'ready_at'),
    ('orders', 'fulfillment_status'),
    ('cash_ledger_entries', 'idempotency_key'),
    ('print_jobs', 'job_type'),
    ('print_jobs', 'status'),
    ('users', 'normalized_email'),
    ('users', 'identity_status'),
    ('users', 'provisioning_status'),
    ('users', 'provisioning_error')
  ) AS expected(table_name, column_name)
  LEFT JOIN information_schema.columns actual
    ON actual.table_schema = 'public'
   AND actual.table_name = expected.table_name
   AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
  LIMIT 1;

  IF missing_column IS NOT NULL THEN
    RAISE EXCEPTION 'missing required upgraded column: %', missing_column;
  END IF;

  IF to_regclass('public.clerk_webhook_events') IS NULL THEN
    RAISE EXCEPTION 'missing required table: clerk_webhook_events';
  END IF;
END $$;

DO $$
DECLARE
  required_fk text;
BEGIN
  FOR required_fk IN
    SELECT column_name
    FROM (VALUES
      ('orders', 'prepared_by_user_id', 'users'),
      ('orders', 'assigned_shift_id', 'lab_tech_shifts'),
      ('orders', 'assigned_csr_user_id', 'users'),
      ('cash_ledger_entries', 'shift_id', 'lab_tech_shifts')
    ) AS required(table_name, column_name, referenced_table)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class source_table ON source_table.oid = c.conrelid
      JOIN pg_class target_table ON target_table.oid = c.confrelid
      JOIN pg_attribute source_column
        ON source_column.attrelid = c.conrelid
       AND source_column.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.convalidated
        AND source_table.relname = required.table_name
        AND source_column.attname = required.column_name
        AND target_table.relname = required.referenced_table
    )
  LOOP
    RAISE EXCEPTION 'missing or unvalidated required foreign key for column: %', required_fk;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.cash_ledger_entries_idempotency_key_idx') IS NULL
    OR to_regclass('public.cash_ledger_entries_order_cash_closeout_idx') IS NULL THEN
    RAISE EXCEPTION 'missing cash closeout idempotency index';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'print_jobs'
      AND column_name = 'job_type'
      AND is_generated = 'ALWAYS'
      AND generation_expression LIKE '%job_output%'
  ) THEN
    RAISE EXCEPTION 'print_jobs.job_type is not a generated compatibility column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'print_jobs'::regclass
      AND conname = 'print_jobs_status_check'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'print_jobs.status check is missing or unvalidated';
  END IF;

  IF to_regclass('public.users_normalized_email_unique') IS NULL THEN
    RAISE EXCEPTION 'users normalized-email unique index is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users
    WHERE normalized_email IS NOT NULL
    GROUP BY normalized_email
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate non-null users.normalized_email values remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users u
    JOIN (
      SELECT lower(trim(email)) AS normalized_email
      FROM users
      WHERE nullif(trim(email), '') IS NOT NULL
      GROUP BY lower(trim(email))
      HAVING count(*) > 1
    ) duplicates ON duplicates.normalized_email = lower(trim(u.email))
    WHERE u.normalized_email IS NOT NULL
       OR u.identity_status <> 'identity_mismatch'
       OR u.provisioning_status <> 'provisioning_failed'
       OR u.provisioning_error <> 'normalized_email_collision'
  ) THEN
    RAISE EXCEPTION 'duplicate source emails were not safely quarantined';
  END IF;
END $$;

SELECT 'migration_ledger_rows' AS check_name, count(*)::text AS result
FROM drizzle.__drizzle_migrations
UNION ALL
SELECT 'required_columns', '20'
UNION ALL
SELECT 'validated_routing_lifecycle_fks', count(*)::text
FROM (VALUES
  ('orders', 'prepared_by_user_id', 'users'),
  ('orders', 'assigned_shift_id', 'lab_tech_shifts'),
  ('orders', 'assigned_csr_user_id', 'users'),
  ('cash_ledger_entries', 'shift_id', 'lab_tech_shifts')
) AS required(table_name, column_name, referenced_table)
WHERE EXISTS (
  SELECT 1
  FROM pg_constraint c
  JOIN pg_class source_table ON source_table.oid = c.conrelid
  JOIN pg_class target_table ON target_table.oid = c.confrelid
  JOIN pg_attribute source_column
    ON source_column.attrelid = c.conrelid
   AND source_column.attnum = ANY (c.conkey)
  WHERE c.contype = 'f'
    AND c.convalidated
    AND source_table.relname = required.table_name
    AND source_column.attname = required.column_name
    AND target_table.relname = required.referenced_table
)
UNION ALL
SELECT 'cash_idempotency_indexes', count(*)::text
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'cash_ledger_entries_idempotency_key_idx',
    'cash_ledger_entries_order_cash_closeout_idx'
  )
UNION ALL
SELECT 'print_job_type_matches_legacy', count(*) FILTER (WHERE job_type = job_output)::text
FROM print_jobs
UNION ALL
SELECT 'print_job_rows', count(*)::text
FROM print_jobs
UNION ALL
SELECT 'normalized_email_collisions_quarantined', count(*)::text
FROM users
WHERE provisioning_error = 'normalized_email_collision'
UNION ALL
SELECT 'duplicate_nonnull_normalized_emails', count(*)::text
FROM (
  SELECT normalized_email
  FROM users
  WHERE normalized_email IS NOT NULL
  GROUP BY normalized_email
  HAVING count(*) > 1
) duplicates;

COMMIT;
