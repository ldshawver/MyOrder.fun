#!/usr/bin/env bash
# Test-only disposable PostgreSQL fixture for guest-checkout integration tests.
# It intentionally uses the established checkout-route schema fixture: this is
# a behavior-test fixture, never a migration-lineage rehearsal.
set -Eeuo pipefail
die() { echo "ERROR: $*" >&2; exit 1; }
root="$(git rev-parse --show-toplevel)"
# Reuse the checkout fixture's established disposable-name allowlist.
name="myorder_p0_owner_approval_guest_checkout_${RANDOM}_${RANDOM}"
port="${MYORDER_GUEST_TEST_PORT:-55437}"
case "$port" in *[!0-9]*|"") die "invalid test port";; esac
case "${DATABASE_URL:-}" in "") ;; *) die "DATABASE_URL must not be supplied; bootstrap owns its disposable target";; esac
docker run --rm -d --name "$name" -e POSTGRES_DB="$name" -e POSTGRES_USER="$name" -e POSTGRES_PASSWORD=guest_checkout_test_only -p "127.0.0.1:${port}:5432" postgres:16-alpine >/dev/null
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 1 30); do docker exec "$name" pg_isready -U "$name" -d "$name" >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U "$name" -d "$name" >/dev/null 2>&1 || die "disposable postgres did not become ready"
db_scheme="postgresql"
DATABASE_URL="${db_scheme}://${name}:guest_checkout_test_only@127.0.0.1:${port}/${name}"
export DATABASE_URL DB_SSL=false MYORDER_REPLAY_JOURNAL=true
export MYORDER_GUEST_TEST_DATABASE_URL="$DATABASE_URL"
"$root/scripts/release/ci-checkout-route-schema.sh"
required_relations=(
  catalogue_products catalogue_options inventory_items inventory_balances
  location_pickup_schedules tax_configurations guest_order_identities
  guest_checkout_sessions orders order_items inventory_reservations
  inventory_movements cash_ledger_entries payment_attempts print_jobs
  notifications audit_logs general_queue_cash_sessions
  general_queue_cash_session_participants
)
for relation in "${required_relations[@]}"; do
  present="$(psql -Atqc "SELECT to_regclass('public.$relation') IS NOT NULL" "$DATABASE_URL")"
  [ "$present" = "t" ] || die "guest checkout fixture schema is missing required relation: $relation"
done
echo "guest checkout behavior fixture ready: $DATABASE_URL"
# The caller may select a focused behavior test.  It runs while this script
# owns the disposable container, and the trap remains responsible for cleanup.
if [[ -n "${MYORDER_GUEST_TEST_COMMAND:-}" ]]; then
  bash -lc "$MYORDER_GUEST_TEST_COMMAND"
else
  pnpm --filter @workspace/api-server exec vitest run src/lib/__tests__/guestTokens.test.ts
fi
