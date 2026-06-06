#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# setup-vps.sh  —  First-time VPS setup for myorder.fun
# Run once on your VPS after cloning the repo.
# Usage: bash deploy/setup-vps.sh
# ─────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "══════════════════════════════════════════════"
echo "  myorder.fun — VPS Setup"
echo "══════════════════════════════════════════════"
echo ""

# ── 1. Check DATABASE_URL ────────────────────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Export it before running this script:"
  echo "  export DATABASE_URL=postgresql://user:pass@localhost/myorder"
  exit 1
fi
echo "✓ DATABASE_URL is set"

# ── 2. Install dependencies ──────────────────────────────────────
echo ""
echo "→ Installing dependencies..."
pnpm install --no-frozen-lockfile

# ── 3. Create schema + seed catalog ─────────────────────────────
echo ""
echo "→ Setting up database schema and seeding catalog..."
psql "$DATABASE_URL" -f deploy/vps-database.sql
echo "✓ Schema created and catalog seeded (80 items, 2 tenants)"

# ── 5. Build frontend ────────────────────────────────────────────
echo ""
echo "→ Building frontend..."
bash deploy/build.sh

# ── 6. Admin user instructions ───────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  Setup complete!"
echo "══════════════════════════════════════════════"
echo ""
echo "NEXT: Start the API server:"
echo "  pm2 start deploy/ecosystem.config.cjs"
echo ""
echo "THEN: Sign in at https://myorder.fun and run"
echo "  the following in psql to make yourself admin:"
echo ""
echo "  UPDATE users"
echo "    SET role = 'global_admin',"
echo "        email = 'luke@adiken.com',"
echo "        first_name = 'Luke',"
echo "        last_name = 'Shawver'"
echo "    WHERE clerk_id = 'user_3Bn2uTv5TRx4kTwYbGDFYMezWPY';"
echo ""
