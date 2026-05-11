#!/usr/bin/env bash
# Migration entrypoint for the Docker migrate service.
# Runs pre-flight diagnostics, then applies drizzle-kit migrations safely.
set -Eeuo pipefail

echo "════════════════════════════════════════════════════════"
echo "  DATABASE MIGRATION"
echo "  $(date -u)"
echo "════════════════════════════════════════════════════════"

# ── Runtime versions ──────────────────────────────────────────────────────────
echo ""
echo "▶ Runtime versions"
node --version
pnpm --version
echo "  pwd: $(pwd)"

# ── Masked DATABASE_URL ───────────────────────────────────────────────────────
echo ""
echo "▶ DATABASE_URL (masked — host + db only, never password)"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "  ERROR: DATABASE_URL is not set" >&2
  exit 1
fi
DB_HOST=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname)")
DB_PORT=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.port||'5432')")
DB_NAME=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.slice(1))")
echo "  host : ${DB_HOST}"
echo "  port : ${DB_PORT}"
echo "  db   : ${DB_NAME}"

# ── Wait for Postgres ─────────────────────────────────────────────────────────
echo ""
echo "▶ Waiting for Postgres to accept connections (pg_isready)..."
RETRIES=30
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -q; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "  ERROR: Postgres did not become ready in time" >&2
    exit 1
  fi
  echo "  not ready — retrying in 2s... (${RETRIES} attempts left)"
  sleep 2
done
echo "  ✓ Postgres is accepting connections"

# ── Pre-migration DB check ────────────────────────────────────────────────────
echo ""
echo "▶ Running pre-migration connectivity check (check-db)..."
cd /app
if ! pnpm --filter @workspace/db db:check; then
  echo ""
  echo "  ✗ db:check failed — running diagnostics:" >&2
  echo "  ENV keys present: $(env | grep -E '^(DATABASE|POSTGRES|PG)' | sed 's/=.*/=<redacted>/' | tr '\n' ' ')"
  echo "  drizzle.config.ts exists: $(test -f /app/lib/db/drizzle.config.ts && echo YES || echo NO)"
  echo "  Schema index exists: $(test -f /app/lib/db/src/schema/index.ts && echo YES || echo NO)"
  echo "  Drizzle migrations dir: $(ls /app/lib/db/drizzle/ 2>/dev/null | head -20 || echo 'MISSING')"
  exit 1
fi

# ── Run migrations ────────────────────────────────────────────────────────────
echo ""
echo "▶ Running migrations: drizzle-kit migrate"
echo "  (Safe — applies pending SQL files from lib/db/drizzle/ in order."
echo "   Does NOT drop or reset tables. Use push-force only for dev resets.)"
echo ""

MIGRATE_EXIT=0
pnpm --filter @workspace/db db:migrate:verbose 2>&1 || MIGRATE_EXIT=$?

if [ "$MIGRATE_EXIT" -ne 0 ]; then
  echo ""
  echo "  ✗ Migration failed (exit ${MIGRATE_EXIT}) — running diagnostics:" >&2
  echo ""
  echo "  ── ENV keys ──"
  env | grep -E '^(DATABASE|POSTGRES|PG|NODE)' | sed 's/=.*/=<redacted>/' || true
  echo ""
  echo "  ── drizzle.config.ts ──"
  test -f /app/lib/db/drizzle.config.ts && echo "EXISTS" || echo "MISSING"
  echo ""
  echo "  ── migration files ──"
  ls /app/lib/db/drizzle/ 2>/dev/null || echo "drizzle/ directory missing"
  echo ""
  echo "  ── schema index ──"
  test -f /app/lib/db/src/schema/index.ts && echo "EXISTS" || echo "MISSING"
  echo ""
  echo "  ── pg_isready final check ──"
  pg_isready -h "${DB_HOST}" -p "${DB_PORT}" && echo "Postgres still up" || echo "Postgres unreachable"
  exit "$MIGRATE_EXIT"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "  MIGRATION SUCCESS — $(date -u)"
echo "════════════════════════════════════════════════════════"
