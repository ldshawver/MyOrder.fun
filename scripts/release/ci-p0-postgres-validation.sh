#!/usr/bin/env bash
# CI-only PostgreSQL 16 rehearsal for the standalone owner-provenance patch.
# It builds a disposable schema fixture at the production 0067 boundary and
# records the exact 0067 journal prefix. The legacy pre-journal production
# baseline is not available in source, so this intentionally does not claim to
# replay all historical SQL migrations from an empty database.
set -Eeuo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

DATABASE_URL="${DATABASE_URL:?CI PostgreSQL DATABASE_URL is required}"
DB_SSL=false
export DATABASE_URL DB_SSL
database_name="${DATABASE_URL##*/}"
case "$database_name" in
  myorder_p0_owner_approval_*) ;;
  *) die "refusing database without disposable myorder_p0_owner_approval_ prefix" ;;
esac

server_version="$(psql "$DATABASE_URL" -Atqc 'SHOW server_version_num')"
case "$server_version" in 16*) ;; *) die "expected PostgreSQL 16, got $server_version" ;; esac

repo_root="$(git rev-parse --show-toplevel)"
drizzle_source="$repo_root/lib/db/drizzle"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/myorder-p0-pg16.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

node --input-type=module - "$drizzle_source/meta/_journal.json" <<'NODE'
import { readFileSync } from 'node:fs';
const journalPath = process.argv[2];
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const boundary = journal.entries.findIndex((entry) => entry.tag === '0067_print_routes_document_types');
const deferred = journal.entries.findIndex((entry) => entry.tag === '0068_print_jobs_document_job_types');
if (boundary !== 41 || deferred !== boundary + 1 || journal.entries.length <= deferred) {
  throw new Error('expected the production 0067 boundary followed by deferred 0068 and retained later journal entries');
}
NODE

# This is a schema fixture only: it contains the columns touched by the P0 API
# plus validator-required baseline tables. In particular, print_jobs retains
# the legacy 0045 constraint and print_routes includes the 0067 document types.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
CREATE TABLE public.tenants (
  id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending', plan text NOT NULL DEFAULT 'standard',
  contact_email text, settings jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.users (
  id serial PRIMARY KEY, clerk_id text NOT NULL UNIQUE, email text, normalized_email text,
  first_name text, last_name text, role text NOT NULL DEFAULT 'user', tenant_id integer,
  mfa_enabled boolean NOT NULL DEFAULT false, mfa_secret text, mfa_backup_codes text,
  contact_phone text, avatar_url text,
  notification_preferences jsonb DEFAULT '{"orderAlerts":"sound","platformUpdates":"in_app"}',
  status text NOT NULL DEFAULT 'pending', is_active boolean NOT NULL DEFAULT true,
  is_default_tech boolean NOT NULL DEFAULT false, identity_status text NOT NULL DEFAULT 'verification_pending',
  provisioning_status text NOT NULL DEFAULT 'pending', provisioning_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.clerk_webhook_events (
  id text PRIMARY KEY, event_type text NOT NULL, clerk_user_id text,
  processed_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'processed', error text
);
CREATE TABLE public.orders (
  id serial PRIMARY KEY, tenant_id integer NOT NULL, customer_id integer NOT NULL,
  subtotal numeric(10,2) NOT NULL, total numeric(10,2) NOT NULL
);
CREATE TABLE public.payment_refunds (
  id serial PRIMARY KEY,
  state text NOT NULL,
  CONSTRAINT payment_refunds_state_check CHECK (state IN (
    'requested', 'provider_succeeded', 'locally_finalized', 'completed',
    'pending', 'failed', 'reconciliation_required'
  ))
);
CREATE TABLE public.catalog_items (
  id serial PRIMARY KEY, tenant_id integer, name text, is_available boolean DEFAULT true
);
CREATE TABLE public.inventory_templates (id serial PRIMARY KEY);
CREATE TABLE public.order_items (
  id serial PRIMARY KEY, order_id integer, catalog_item_id integer
);
CREATE TABLE public.shift_inventory_items (id serial PRIMARY KEY);
CREATE TABLE public.audit_logs (
  id serial PRIMARY KEY, tenant_id integer, actor_id integer NOT NULL,
  actor_email text NOT NULL, actor_role text NOT NULL, action text NOT NULL,
  resource_output text, resource_id text, metadata jsonb DEFAULT '{}',
  ip_address text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.notifications (
  id serial PRIMARY KEY, user_id integer NOT NULL, type text NOT NULL,
  title text NOT NULL, message text NOT NULL, is_read boolean NOT NULL DEFAULT false,
  resource_output text, resource_id integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lab_tech_shifts (
  id serial PRIMARY KEY, tenant_id integer NOT NULL, tech_id integer NOT NULL,
  status text NOT NULL DEFAULT 'active', ip_address text, box_assignment_id text,
  setup_json jsonb DEFAULT '{}', clocked_in_at timestamptz NOT NULL DEFAULT now(),
  clocked_out_at timestamptz, cash_bank_start numeric(10,2) DEFAULT 0,
  cash_bank_end numeric(10,2), cash_bank_end_reported numeric(10,2),
  tip_percent_selected numeric(5,2), tip_amount numeric(10,2), difference_amount numeric(10,2) DEFAULT 0,
  deposit_amount numeric(10,2), supervisor_id integer, supervisor_confirmed_at timestamptz,
  payment_totals_json jsonb, summary jsonb, csr_delivery_opt_in boolean NOT NULL DEFAULT false,
  csr_delivery_earnings numeric(10,2) DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.print_jobs (
  id serial PRIMARY KEY, tenant_id integer NOT NULL, job_output text NOT NULL DEFAULT 'order_ticket',
  job_type text GENERATED ALWAYS AS (job_output) STORED,
  CONSTRAINT print_jobs_job_type_check CHECK (job_type IN (
    'order_ticket', 'receipt', 'label', 'customer_receipt', 'expo_ticket',
    'shift_start_receipt', 'shift_end_receipt', 'thank_you_sticker', 'receipt_template_test'
  ))
);
CREATE TABLE public.print_routes (
  id serial PRIMARY KEY, tenant_id integer NOT NULL, job_type text NOT NULL,
  CONSTRAINT print_routes_job_type_check CHECK (job_type IN (
    'thank_you_sticker', 'ORDER_RECEIPT', 'CLOCK_IN', 'CLOCK_OUT',
    'INVENTORY_STOCK_LIST', 'DEPOSIT', 'EXPO', 'WORK', 'REPORT'
  ))
);
SQL

# Seed a data row so the before/after preservation assertion is meaningful.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -Atqc "
  INSERT INTO public.tenants (name, slug, status)
  VALUES ('CI authorization tenant', 'ci-owner-approval', 'active');
  INSERT INTO public.users (clerk_id, email, role, status, tenant_id)
  VALUES ('ci-p0-preservation-user', 'ci-p0-preservation@example.invalid', 'user', 'approved',
          (SELECT id FROM public.tenants WHERE slug='ci-owner-approval'));
  INSERT INTO public.orders (tenant_id, customer_id, subtotal, total)
  SELECT t.id, u.id, 10, 10 FROM public.tenants t, public.users u
   WHERE t.slug='ci-owner-approval' AND u.clerk_id='ci-p0-preservation-user';"

# Reproduce the canonical applied ledger prefix through 0067 using the actual
# SHA-256 of each checked-in SQL file and the canonical journal timestamps.
CI_P0_REPO_ROOT="$repo_root" pnpm --filter @workspace/db exec node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
const repo = process.env.CI_P0_REPO_ROOT;
const dir = path.join(repo, 'lib/db/drizzle');
const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8'));
const deferredIndex = journal.entries.findIndex((entry) => entry.tag === '0068_print_jobs_document_job_types');
if (deferredIndex !== 42 || journal.entries[deferredIndex - 1]?.tag !== '0067_print_routes_document_types') {
  throw new Error('expected 0068 immediately after the production 0067 boundary');
}
const entries = journal.entries.slice(0, deferredIndex);
if (entries.length !== 42 || entries.at(-1)?.tag !== '0067_print_routes_document_types') {
  throw new Error('expected exactly the 42-entry production prefix through 0067');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('CREATE SCHEMA drizzle');
  await client.query('CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
  for (const entry of entries) {
    const sql = readFileSync(path.join(dir, `${entry.tag}.sql`));
    const hash = createHash('sha256').update(sql).digest('hex');
    await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [hash, entry.when]);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
NODE

pnpm --filter @workspace/db db:validate-migrations

before_users="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM public.users')"
before_orders="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM public.orders')"
for attempt in 1 2; do
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < "$repo_root/deploy/hotfix-owner-approval.sql"
done
after_users="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM public.users')"
after_orders="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM public.orders')"
test "$before_users" = "$after_users" || die "hotfix changed user count"
test "$before_orders" = "$after_orders" || die "hotfix changed order count"

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -Atqc "
  SELECT CASE WHEN
    (SELECT count(*) FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance') = 1
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_by_clerk_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_at')
    AND to_regclass('public.users_owner_approval_provenance_idx') IS NOT NULL
    AND (SELECT count(*) FROM drizzle.__drizzle_migrations) = 42
    AND (SELECT max(created_at) FROM drizzle.__drizzle_migrations) = 1790600000002
    AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='print_jobs_job_type_check') NOT LIKE '%shift_clock_in%'
  THEN 'P0 schema, marker, and 0067 ledger verified'
  ELSE 'P0 schema or ledger verification failed' END" | grep -qx 'P0 schema, marker, and 0067 ledger verified' \
  || die "hotfix schema/marker/0067 ledger verification failed"

pnpm --filter @workspace/db db:validate-migrations
echo "P0 PostgreSQL 16 validation passed: representative 0067 schema/ledger fixture, idempotent patch, preserved seeded rows, marker, and Drizzle prefix validation."
