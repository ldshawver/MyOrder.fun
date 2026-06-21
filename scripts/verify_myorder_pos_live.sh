#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://myorder.fun}"
SSH_TARGET="${SSH_TARGET:-}"
DB_URL="${DATABASE_URL:-}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
TMP_DIR="${TMPDIR:-/tmp}/myorder-pos-live-proof"
mkdir -p "$TMP_DIR"

log() { printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null || fail "Missing required command: $1"; }

require curl
require jq

log "Checking deployed health at $BASE_URL/api/healthz"
curl -fsS "$BASE_URL/api/healthz" | tee "$TMP_DIR/healthz.json" | jq . >/dev/null

if [[ -n "$EXPECTED_SHA" ]]; then
  log "Checking deployed git SHA"
  curl -fsS "$BASE_URL/api/healthz" | jq -e --arg sha "$EXPECTED_SHA" '(.gitSha // .sha // .version // "") | tostring | contains($sha)' >/dev/null \
    || fail "Deployed SHA does not contain EXPECTED_SHA=$EXPECTED_SHA"
fi

log "Checking public catalog endpoint"
curl -fsS "$BASE_URL/api/catalog" | tee "$TMP_DIR/catalog.json" | jq '.items // .catalog // .' >/dev/null

log "Checking customer catalog has no private fields"
PRIVATE_RE='safe|lucifer|cost|supplier|margin|internalSku|merchantSku|compliance|boxAssignment|quantityOnHand|parLevel'
if jq -e --arg re "$PRIVATE_RE" '.. | objects | keys[]? | select(test($re; "i"))' "$TMP_DIR/catalog.json" >/dev/null; then
  jq -r --arg re "$PRIVATE_RE" '.. | objects | keys[]? | select(test($re; "i"))' "$TMP_DIR/catalog.json" | sort -u >&2
  fail "Public catalog exposed private/internal field names"
fi

log "Checking admin import endpoint requires auth"
status=$(curl -sS -o "$TMP_DIR/admin_import_unauth.json" -w '%{http_code}' -X POST "$BASE_URL/api/admin/import/product-master")
[[ "$status" == "401" || "$status" == "403" ]] || fail "Admin import endpoint returned $status without auth"

if [[ -n "$DB_URL" ]]; then
  require psql
  log "Checking Product Master inventory balance count for product IDs 354-388"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM inventory_balances WHERE product_id BETWEEN 354 AND 388;" | tee "$TMP_DIR/inventory_354_388_count.txt"
  count=$(psql "$DB_URL" -At -c "SELECT count(*) FROM inventory_balances WHERE product_id BETWEEN 354 AND 388;")
  [[ "$count" == "140" ]] || fail "Expected 140 inventory balances for products 354-388, got $count"

  log "Checking queued print jobs exist"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SELECT job_type, status, count(*) FROM print_jobs WHERE created_at > now() - interval '24 hours' GROUP BY job_type, status ORDER BY job_type, status;" | tee "$TMP_DIR/print_jobs_recent.txt"

  log "Checking migrations table presence"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.__drizzle_migrations') AS drizzle_migrations;" | tee "$TMP_DIR/migrations.txt"
else
  log "DATABASE_URL not set; skipped SQL count, migrations, inventory before/after, and print_jobs DB checks"
fi

if [[ -n "$SSH_TARGET" ]]; then
  require ssh
  log "Checking remote containers"
  ssh "$SSH_TARGET" 'docker ps --format "table {{.Names}}\t{{.Status}}"' | tee "$TMP_DIR/docker_ps.txt"
  log "Checking recent docker/journal logs for 500/errors"
  ssh "$SSH_TARGET" 'docker logs --since=30m myorder-api 2>&1 || journalctl -u myorder-api --since "30 min ago" --no-pager 2>&1 || true' | tee "$TMP_DIR/recent_logs.txt"
  if grep -Ei '(^|[^0-9])500([^0-9]|$)|uncaught|unhandled|fatal|panic' "$TMP_DIR/recent_logs.txt"; then
    fail "Recent backend logs contain 500/errors"
  fi
else
  log "SSH_TARGET not set; skipped docker/journal log checks"
fi

log "Live verification artifacts written to $TMP_DIR"
