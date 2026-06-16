-- Safely remove Codex/Replit-created fake test employees for the known target tenant only.
-- Target tenant/company: tenant_id = 1 (single-tenant house company in this repo).
-- This migration intentionally refuses to hard-delete same-name users unless they are
-- both in the target tenant and clearly look like test/demo seeded records.

CREATE TABLE IF NOT EXISTS "test_employee_cleanup_backup" (
  "cleanup_run_id" text NOT NULL,
  "user_id" integer,
  "employee_id" integer,
  "full_name" text,
  "email" text,
  "company_id" integer,
  "table_name" text NOT NULL,
  "record_json" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "test_employee_cleanup_preview" (
  "cleanup_run_id" text NOT NULL,
  "user_id" integer,
  "employee_id" integer,
  "full_name" text,
  "email" text,
  "role" text,
  "company_id" integer,
  "created_at" timestamp with time zone,
  "created_by_source" text,
  "related_record_counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_delete_eligible" boolean NOT NULL DEFAULT false,
  "manual_review_reason" text,
  "previewed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TEMP TABLE _cleanup_config (
  cleanup_run_id text PRIMARY KEY,
  target_tenant_id integer NOT NULL
);

INSERT INTO _cleanup_config (cleanup_run_id, target_tenant_id)
VALUES ('test-employee-cleanup-2026-06-13', 1)
ON CONFLICT (cleanup_run_id) DO UPDATE
SET target_tenant_id = EXCLUDED.target_tenant_id;

CREATE TEMP TABLE _target_test_employee_names (
  first_name text NOT NULL,
  last_name text NOT NULL
);

-- Duplicates in the user's pasted request are intentional: every matching
-- duplicate user row in the target tenant is evaluated independently below.
INSERT INTO _target_test_employee_names (first_name, last_name)
VALUES
  ('Izek', 'Brit'),
  ('Michael', 'Chen'),
  ('Sarah', 'Johnson'),
  ('Emily', 'Rodriguez'),
  ('Michael', 'Thompson');

CREATE TEMP TABLE _candidate_test_employee_users (
  user_id integer PRIMARY KEY,
  employee_id integer,
  full_name text,
  email text,
  role text,
  company_id integer,
  created_at timestamp with time zone,
  created_by_source text,
  is_fake_source boolean NOT NULL DEFAULT false,
  has_sensitive_records boolean NOT NULL DEFAULT false,
  sensitive_record_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  related_record_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_delete_eligible boolean NOT NULL DEFAULT false,
  manual_review_reason text
);

WITH normalized_names AS (
  SELECT DISTINCT
    lower(regexp_replace(replace(btrim(first_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS first_name,
    lower(regexp_replace(replace(btrim(last_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS last_name,
    lower(regexp_replace(replace(btrim(first_name || ' ' || last_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS full_name
  FROM _target_test_employee_names
), matched AS (
  SELECT
    u.id AS user_id,
    u.id AS employee_id,
    regexp_replace(replace(btrim(coalesce(u."first_name", '') || ' ' || coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g') AS full_name,
    u."email" AS email,
    u."role" AS role,
    u."tenant_id" AS company_id,
    u."created_at" AS created_at,
    concat_ws(' | ', 'clerk_id=' || coalesce(u."clerk_id", ''), 'status=' || coalesce(u."status", ''), 'is_active=' || coalesce(u."is_active"::text, '')) AS created_by_source,
    (
      lower(coalesce(u."clerk_id", '')) SIMILAR TO '%(codex|replit|test|demo|fake|mock|seed)%'
      OR lower(coalesce(u."email", '')) SIMILAR TO '%(codex|replit|test|demo|fake|mock|seed|example.com|example.test)%'
      OR lower(coalesce(u."email", '')) LIKE '%+test%'
    ) AS is_fake_source
  FROM "users" u
  CROSS JOIN _cleanup_config cfg
  JOIN normalized_names n ON (
    lower(regexp_replace(replace(btrim(coalesce(u."first_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.first_name
    AND lower(regexp_replace(replace(btrim(coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.last_name
  ) OR lower(regexp_replace(replace(btrim(coalesce(u."first_name", '') || ' ' || coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.full_name
  WHERE u."tenant_id" = cfg.target_tenant_id
)
INSERT INTO _candidate_test_employee_users (
  user_id, employee_id, full_name, email, role, company_id, created_at, created_by_source, is_fake_source
)
SELECT user_id, employee_id, nullif(full_name, ''), email, role, company_id, created_at, created_by_source, is_fake_source
FROM matched
ON CONFLICT (user_id) DO NOTHING;

CREATE TEMP TABLE _sensitive_record_counts (
  user_id integer NOT NULL,
  table_name text NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, table_name)
);

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('payroll_history', 'user_id'),
      ('payroll_history', 'employee_id'),
      ('paychecks', 'user_id'),
      ('paychecks', 'employee_id'),
      ('tax_records', 'user_id'),
      ('tax_records', 'employee_id'),
      ('timeclock_punches', 'user_id'),
      ('timeclock_punches', 'employee_id'),
      ('documents', 'user_id'),
      ('documents', 'employee_id'),
      ('employee_documents', 'user_id'),
      ('employee_documents', 'employee_id'),
      ('onboarding_completions', 'user_id'),
      ('onboarding_completions', 'employee_id'),
      ('user_login_history', 'user_id'),
      ('login_history', 'user_id'),
      ('sessions', 'user_id')
    ) AS s(table_name, column_name)
  LOOP
    IF to_regclass('public.' || spec.table_name) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = spec.table_name
           AND column_name = spec.column_name
       ) THEN
      EXECUTE format(
        'INSERT INTO _sensitive_record_counts (user_id, table_name, record_count)
         SELECT c.user_id, %L, count(*)::int
         FROM _candidate_test_employee_users c
         JOIN %I t ON t.%I = c.user_id
         GROUP BY c.user_id
         ON CONFLICT (user_id, table_name) DO UPDATE
         SET record_count = _sensitive_record_counts.record_count + EXCLUDED.record_count',
        spec.table_name,
        spec.table_name,
        spec.column_name
      );
    END IF;
  END LOOP;
END $$;

UPDATE _candidate_test_employee_users c
SET sensitive_record_counts = coalesce(s.counts, '{}'::jsonb),
    has_sensitive_records = coalesce(s.total_count, 0) > 0
FROM (
  SELECT user_id, jsonb_object_agg(table_name, record_count) AS counts, sum(record_count) AS total_count
  FROM _sensitive_record_counts
  WHERE record_count > 0
  GROUP BY user_id
) s
WHERE s.user_id = c.user_id;

UPDATE _candidate_test_employee_users c
SET related_record_counts = jsonb_build_object(
  'orders_as_customer', (SELECT count(*) FROM "orders" o WHERE to_regclass('public.orders') IS NOT NULL AND o."customer_id" = c.user_id),
  'orders_assigned_csr', (SELECT count(*) FROM "orders" o WHERE to_regclass('public.orders') IS NOT NULL AND o."assigned_csr_user_id" = c.user_id),
  'orders_handoff_completed_by', (SELECT count(*) FROM "orders" o WHERE to_regclass('public.orders') IS NOT NULL AND o."handoff_completed_by_user_id" = c.user_id),
  'lab_tech_shifts_as_tech', (SELECT count(*) FROM "lab_tech_shifts" s WHERE to_regclass('public.lab_tech_shifts') IS NOT NULL AND s."tech_id" = c.user_id),
  'lab_tech_shifts_as_supervisor', (SELECT count(*) FROM "lab_tech_shifts" s WHERE to_regclass('public.lab_tech_shifts') IS NOT NULL AND s."supervisor_id" = c.user_id),
  'order_notes', (SELECT count(*) FROM "order_notes" n WHERE to_regclass('public.order_notes') IS NOT NULL AND n."author_id" = c.user_id),
  'feedback_tickets_submitter', (SELECT count(*) FROM "feedback_tickets" f WHERE to_regclass('public.feedback_tickets') IS NOT NULL AND f."submitter_id" = c.user_id),
  'feedback_ticket_comments', (SELECT count(*) FROM "feedback_ticket_comments" f WHERE to_regclass('public.feedback_ticket_comments') IS NOT NULL AND f."author_id" = c.user_id),
  'notifications', (SELECT count(*) FROM "notifications" n WHERE to_regclass('public.notifications') IS NOT NULL AND n."user_id" = c.user_id),
  'audit_logs', (SELECT count(*) FROM "audit_logs" a WHERE to_regclass('public.audit_logs') IS NOT NULL AND a."actor_id" = c.user_id),
  'user_credits', (SELECT count(*) FROM "user_credits" uc WHERE to_regclass('public.user_credits') IS NOT NULL AND uc."user_id" = c.user_id),
  'operator_print_profiles', (SELECT count(*) FROM "operator_print_profiles" p WHERE to_regclass('public.operator_print_profiles') IS NOT NULL AND p."user_id" = c.user_id)
);

UPDATE _candidate_test_employee_users
SET is_delete_eligible = is_fake_source AND NOT has_sensitive_records,
    manual_review_reason = CASE
      WHEN has_sensitive_records THEN 'manual review required: payroll/paycheck/tax/timeclock/document/onboarding/login records exist'
      WHEN NOT is_fake_source THEN 'manual review required: name and tenant match, but email/clerk_id does not clearly indicate Codex/Replit/test/demo seed data'
      ELSE NULL
    END;

DELETE FROM "test_employee_cleanup_preview" p
USING _cleanup_config cfg
WHERE p."cleanup_run_id" = cfg.cleanup_run_id;

INSERT INTO "test_employee_cleanup_preview" (
  "cleanup_run_id", "user_id", "employee_id", "full_name", "email", "role", "company_id",
  "created_at", "created_by_source", "related_record_counts", "is_delete_eligible", "manual_review_reason"
)
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.role, c.company_id,
       c.created_at, c.created_by_source, c.related_record_counts, c.is_delete_eligible, c.manual_review_reason
FROM _candidate_test_employee_users c
CROSS JOIN _cleanup_config cfg;

INSERT INTO "test_employee_cleanup_backup" (
  "cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json"
)
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, '__preview__', to_jsonb(c)
FROM _candidate_test_employee_users c
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (
  SELECT 1 FROM "test_employee_cleanup_backup" b
  WHERE b."cleanup_run_id" = cfg.cleanup_run_id
    AND b."user_id" = c.user_id
    AND b."table_name" = '__preview__'
);

CREATE TEMP TABLE _eligible_test_employee_users AS
SELECT *
FROM _candidate_test_employee_users
WHERE is_delete_eligible;

CREATE TEMP TABLE _eligible_customer_orders AS
SELECT o.id
FROM "orders" o
JOIN _eligible_test_employee_users c ON c.user_id = o."customer_id";

CREATE TEMP TABLE _eligible_shifts AS
SELECT s.id
FROM "lab_tech_shifts" s
JOIN _eligible_test_employee_users c ON c.user_id = s."tech_id" OR c.user_id = s."supervisor_id";

-- Snapshot every row this migration will delete or mutate before touching it.
INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'users', to_jsonb(u)
FROM _eligible_test_employee_users c
JOIN "users" u ON u.id = c.user_id
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."user_id" = c.user_id AND b."table_name" = 'users');

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'orders', to_jsonb(o)
FROM _eligible_test_employee_users c
JOIN "orders" o ON o."customer_id" = c.user_id OR o."assigned_csr_user_id" = c.user_id OR o."handoff_completed_by_user_id" = c.user_id OR o."assigned_tech_id" = c.user_id
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'orders' AND b."record_json"->>'id' = o.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'order_items', to_jsonb(oi)
FROM _eligible_test_employee_users c
JOIN _eligible_customer_orders eo ON true
JOIN "order_items" oi ON oi."order_id" = eo.id
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'order_items' AND b."record_json"->>'id' = oi.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'order_notes', to_jsonb(n)
FROM _eligible_test_employee_users c
JOIN "order_notes" n ON n."author_id" = c.user_id OR n."order_id" IN (SELECT id FROM _eligible_customer_orders)
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'order_notes' AND b."record_json"->>'id' = n.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'lab_tech_shifts', to_jsonb(s)
FROM _eligible_test_employee_users c
JOIN "lab_tech_shifts" s ON s.id IN (SELECT id FROM _eligible_shifts)
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'lab_tech_shifts' AND b."record_json"->>'id' = s.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'shift_inventory_items', to_jsonb(i)
FROM _eligible_test_employee_users c
JOIN "shift_inventory_items" i ON i."shift_id" IN (SELECT id FROM _eligible_shifts)
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'shift_inventory_items' AND b."record_json"->>'id' = i.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'print_jobs', to_jsonb(pj)
FROM _eligible_test_employee_users c
JOIN "print_jobs" pj ON pj."operator_user_id" = c.user_id OR pj."order_id" IN (SELECT id FROM _eligible_customer_orders)
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'print_jobs' AND b."record_json"->>'id' = pj.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, 'print_job_attempts', to_jsonb(pja)
FROM _eligible_test_employee_users c
JOIN "print_jobs" pj ON pj."order_id" IN (SELECT id FROM _eligible_customer_orders)
JOIN "print_job_attempts" pja ON pja."print_job_id" = pj.id
CROSS JOIN _cleanup_config cfg
WHERE NOT EXISTS (SELECT 1 FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = 'print_job_attempts' AND b."record_json"->>'id' = pja.id::text);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "user_id", "employee_id", "full_name", "email", "company_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, c.user_id, c.employee_id, c.full_name, c.email, c.company_id, t.table_name, t.record_json
FROM _eligible_test_employee_users c
CROSS JOIN _cleanup_config cfg
CROSS JOIN LATERAL (
  SELECT 'feedback_tickets' AS table_name, to_jsonb(f) AS record_json FROM "feedback_tickets" f WHERE f."submitter_id" = c.user_id OR f."assignee_id" = c.user_id
  UNION ALL SELECT 'feedback_ticket_comments', to_jsonb(fc) FROM "feedback_ticket_comments" fc WHERE fc."author_id" = c.user_id
  UNION ALL SELECT 'notifications', to_jsonb(n) FROM "notifications" n WHERE n."user_id" = c.user_id
  UNION ALL SELECT 'audit_logs', to_jsonb(a) FROM "audit_logs" a WHERE a."actor_id" = c.user_id
  UNION ALL SELECT 'user_credits', to_jsonb(uc) FROM "user_credits" uc WHERE uc."user_id" = c.user_id OR uc."created_by" = c.user_id
  UNION ALL SELECT 'operator_print_profiles', to_jsonb(opp) FROM "operator_print_profiles" opp WHERE opp."user_id" = c.user_id
  UNION ALL SELECT 'onboarding_requests', to_jsonb(ob) FROM "onboarding_requests" ob WHERE ob."reviewed_by" = c.user_id
  UNION ALL SELECT 'visual_editor_pages', to_jsonb(vep) FROM "visual_editor_pages" vep WHERE c.user_id IN (vep."created_by_id", vep."updated_by_id", vep."published_by_id")
) t
WHERE NOT EXISTS (
  SELECT 1 FROM "test_employee_cleanup_backup" b
  WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = t.table_name AND b."record_json"->>'id' = t.record_json->>'id'
);

INSERT INTO "test_employee_cleanup_backup" ("cleanup_run_id", "table_name", "record_json")
SELECT cfg.cleanup_run_id, '__cleanup_audit__', jsonb_build_object(
  'action', 'test_employee_cleanup',
  'target_tenant_id', cfg.target_tenant_id,
  'eligible_user_ids', (SELECT coalesce(jsonb_agg(user_id ORDER BY user_id), '[]'::jsonb) FROM _eligible_test_employee_users),
  'manual_review_user_ids', (SELECT coalesce(jsonb_agg(user_id ORDER BY user_id), '[]'::jsonb) FROM _candidate_test_employee_users WHERE NOT is_delete_eligible),
  'created_at', now()
)
FROM _cleanup_config cfg
WHERE NOT EXISTS (
  SELECT 1 FROM "test_employee_cleanup_backup" b
  WHERE b."cleanup_run_id" = cfg.cleanup_run_id AND b."table_name" = '__cleanup_audit__'
);

-- FK-safe cleanup. Shared lookup records are intentionally not touched.
DELETE FROM "print_job_attempts"
WHERE "print_job_id" IN (
  SELECT pj.id FROM "print_jobs" pj WHERE pj."order_id" IN (SELECT id FROM _eligible_customer_orders)
);

DELETE FROM "print_jobs"
WHERE "order_id" IN (SELECT id FROM _eligible_customer_orders);

UPDATE "print_jobs"
SET "operator_user_id" = NULL
WHERE "operator_user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "order_notes"
WHERE "order_id" IN (SELECT id FROM _eligible_customer_orders)
   OR "author_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "order_items"
WHERE "order_id" IN (SELECT id FROM _eligible_customer_orders);

UPDATE "orders"
SET "handoff_completed_by_user_id" = NULL
WHERE "handoff_completed_by_user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "orders"
SET "assigned_csr_user_id" = NULL,
    "route_source" = CASE
      WHEN "assigned_csr_user_id" IN (SELECT user_id FROM _eligible_test_employee_users) THEN 'general_account'
      ELSE "route_source"
    END
WHERE "assigned_csr_user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "orders"
SET "assigned_tech_id" = NULL
WHERE "assigned_tech_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "orders"
SET "assigned_shift_id" = NULL
WHERE "assigned_shift_id" IN (SELECT id FROM _eligible_shifts);

DELETE FROM "orders"
WHERE id IN (SELECT id FROM _eligible_customer_orders);

DELETE FROM "shift_inventory_items"
WHERE "shift_id" IN (SELECT id FROM _eligible_shifts);

DELETE FROM "lab_tech_shifts"
WHERE id IN (SELECT id FROM _eligible_shifts);

DELETE FROM "feedback_ticket_comments"
WHERE "author_id" IN (SELECT user_id FROM _eligible_test_employee_users)
   OR "ticket_id" IN (
     SELECT id FROM "feedback_tickets"
     WHERE "submitter_id" IN (SELECT user_id FROM _eligible_test_employee_users)
   );

UPDATE "feedback_tickets"
SET "assignee_id" = NULL
WHERE "assignee_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "feedback_tickets"
WHERE "submitter_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "notifications"
WHERE "user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "audit_logs"
WHERE "actor_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "user_credits"
WHERE "user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "user_credits"
SET "created_by" = NULL
WHERE "created_by" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "operator_print_profiles"
WHERE "user_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "onboarding_requests"
SET "reviewed_by" = NULL
WHERE "reviewed_by" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "visual_editor_pages"
SET "created_by_id" = NULL
WHERE "created_by_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "visual_editor_pages"
SET "updated_by_id" = NULL
WHERE "updated_by_id" IN (SELECT user_id FROM _eligible_test_employee_users);

UPDATE "visual_editor_pages"
SET "published_by_id" = NULL
WHERE "published_by_id" IN (SELECT user_id FROM _eligible_test_employee_users);

DELETE FROM "users"
WHERE id IN (SELECT user_id FROM _eligible_test_employee_users)
  AND "tenant_id" = (SELECT target_tenant_id FROM _cleanup_config);

-- Verification / preview output for migration logs.
WITH normalized_names AS (
  SELECT DISTINCT
    lower(regexp_replace(replace(btrim(first_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS first_name,
    lower(regexp_replace(replace(btrim(last_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS last_name,
    lower(regexp_replace(replace(btrim(first_name || ' ' || last_name), chr(160), ' '), '[[:space:]]+', ' ', 'g')) AS full_name
  FROM _target_test_employee_names
), remaining_target AS (
  SELECT u.id, u."tenant_id", u."email", u."first_name", u."last_name"
  FROM "users" u
  CROSS JOIN _cleanup_config cfg
  JOIN normalized_names n ON (
    lower(regexp_replace(replace(btrim(coalesce(u."first_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.first_name
    AND lower(regexp_replace(replace(btrim(coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.last_name
  ) OR lower(regexp_replace(replace(btrim(coalesce(u."first_name", '') || ' ' || coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.full_name
  WHERE u."tenant_id" = cfg.target_tenant_id
), same_name_other_tenants AS (
  SELECT u.id, u."tenant_id", u."email", u."first_name", u."last_name"
  FROM "users" u
  CROSS JOIN _cleanup_config cfg
  JOIN normalized_names n ON (
    lower(regexp_replace(replace(btrim(coalesce(u."first_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.first_name
    AND lower(regexp_replace(replace(btrim(coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.last_name
  ) OR lower(regexp_replace(replace(btrim(coalesce(u."first_name", '') || ' ' || coalesce(u."last_name", '')), chr(160), ' '), '[[:space:]]+', ' ', 'g')) = n.full_name
  WHERE u."tenant_id" <> cfg.target_tenant_id
)
SELECT
  cfg.cleanup_run_id,
  cfg.target_tenant_id AS company_id,
  (SELECT count(*) FROM "test_employee_cleanup_preview" p WHERE p."cleanup_run_id" = cfg.cleanup_run_id) AS preview_rows,
  (SELECT count(*) FROM "test_employee_cleanup_preview" p WHERE p."cleanup_run_id" = cfg.cleanup_run_id AND p."is_delete_eligible") AS delete_eligible_preview_rows,
  (SELECT count(*) FROM "test_employee_cleanup_preview" p WHERE p."cleanup_run_id" = cfg.cleanup_run_id AND NOT p."is_delete_eligible") AS manual_review_preview_rows,
  (SELECT count(*) FROM remaining_target) AS remaining_target_tenant_matches,
  (SELECT count(*) FROM same_name_other_tenants) AS same_name_other_tenant_rows_still_present,
  (SELECT count(*) FROM "test_employee_cleanup_backup" b WHERE b."cleanup_run_id" = cfg.cleanup_run_id) AS backup_rows
FROM _cleanup_config cfg;
