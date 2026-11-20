#!/usr/bin/env bash
# CI-only schema fixture for the customer checkout route regression test
# (artifacts/api-server/src/routes/__tests__/customer-checkout-route-postgres.integration.test.ts).
#
# The repository has no pre-journal production baseline, so a fresh database
# cannot be built by the release migration runner. This fixture instead pushes
# the current Drizzle schema and then replays the journaled SQL migrations on
# top of it, which adds the tables and triggers that live only in SQL
# (catalogue products/options, inventory items, ...). Statements that collide
# with objects the push already created are expected to fail and are ignored.
# This is a test fixture only; it is never used against a real database.
set -Eeuo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

DATABASE_URL="${DATABASE_URL:?disposable PostgreSQL DATABASE_URL is required}"
database_name="${DATABASE_URL##*/}"
case "$database_name" in
  myorder_p0_owner_approval_*) ;;
  *) die "refusing database without disposable myorder_p0_owner_approval_ prefix" ;;
esac
host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$DATABASE_URL")"
case "$host" in localhost|127.0.0.1|::1) ;; *) die "refusing non-local database host $host" ;; esac

repo_root="$(git rev-parse --show-toplevel)"
export DATABASE_URL DB_SSL=false

(cd "$repo_root/lib/db" && pnpm exec drizzle-kit push --force --config ./drizzle.config.ts)

if [ "${MYORDER_REPLAY_JOURNAL:-true}" = "true" ]; then
# `drizzle-kit push` materializes the current schema, while this fixture also
# replays the historic journal to install SQL-only checkout objects.  The
# current Drizzle schema intentionally omits the superseded 0054 non-zero
# movement constraint, but 0079 replaces that exact historical constraint.
# Recreate only that documented pre-0079 invariant in the disposable fixture;
# this is not a ledger entry, a migration rewrite, or production behavior.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
DO $$
BEGIN
  IF to_regclass('public.inventory_movements') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.inventory_movements'::regclass
         AND conname = 'inventory_movements_quantity_nonzero'
     ) THEN
    ALTER TABLE public.inventory_movements
      ADD CONSTRAINT inventory_movements_quantity_nonzero CHECK (quantity_delta <> 0);
  END IF;
END $$;
SQL
node --input-type=module - "$repo_root/lib/db/drizzle/meta/_journal.json" <<'NODE' | while read -r tag; do
import { readFileSync } from 'node:fs';
for (const entry of JSON.parse(readFileSync(process.argv[2], 'utf8')).entries) console.log(entry.tag);
NODE
  echo "replaying migration $tag" >&2
  log="${TMPDIR:-/tmp}/myorder-migration-${tag}-$$.log"
  if ! timeout 20 psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$repo_root/lib/db/drizzle/$tag.sql" >"$log" 2>&1; then
    # Push-created duplicate objects are expected only in this fixture. Keep
    # their diagnostics; all other SQL errors remain fatal.
    if grep -Eq 'already exists|duplicate key value violates unique constraint' "$log"; then
      echo "expected fixture collision for $tag" >&2
    else
      cat "$log" >&2
      exit 1
    fi
  fi
  rm -f "$log"
done
fi

if [ "${MYORDER_REPLAY_JOURNAL:-true}" = "true" ]; then
for table in catalogue_products catalogue_options inventory_items location_pickup_schedules tax_configurations; do
  present="$(psql -Atqc "SELECT to_regclass('public.$table') IS NOT NULL" "$DATABASE_URL")"
  [ "$present" = "t" ] || die "checkout fixture schema is missing $table"
done
fi
echo "checkout route schema fixture ready"
