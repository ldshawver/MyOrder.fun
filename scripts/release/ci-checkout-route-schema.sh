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

node --input-type=module - "$repo_root/lib/db/drizzle/meta/_journal.json" <<'NODE' | while read -r tag; do
import { readFileSync } from 'node:fs';
for (const entry of JSON.parse(readFileSync(process.argv[2], 'utf8')).entries) console.log(entry.tag);
NODE
  psql -q -v ON_ERROR_STOP=0 "$DATABASE_URL" -f "$repo_root/lib/db/drizzle/$tag.sql" >/dev/null 2>&1 || true
done

for table in catalogue_products catalogue_options inventory_items location_pickup_schedules tax_configurations; do
  present="$(psql -Atqc "SELECT to_regclass('public.$table') IS NOT NULL" "$DATABASE_URL")"
  [ "$present" = "t" ] || die "checkout fixture schema is missing $table"
done
echo "checkout route schema fixture ready"
