#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ── Load environment ────────────────────────────────────────────────────────
# On the VPS, keep a .env file at the repo root. build.sh sources it so
# VITE_CLERK_PUBLISHABLE_KEY and other build-time vars are available.
if [ -f "$REPO_DIR/.env" ]; then
  echo "==> Loading .env file..."
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# ── Validate required build-time env vars ───────────────────────────────────
: "${VITE_CLERK_PUBLISHABLE_KEY:?Need to set VITE_CLERK_PUBLISHABLE_KEY in .env}"
: "${VITE_CLERK_PROXY_URL:?Need to set VITE_CLERK_PROXY_URL in .env}"
: "${DATABASE_URL:?Need to set DATABASE_URL in .env}"

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building lib/db type declarations..."
pnpm --filter @workspace/db exec tsc

echo "==> Pushing DB schema to production database..."
pnpm --filter @workspace/db run push-force

echo "==> Building API server..."
pnpm --filter @workspace/api-server run build

echo "==> Building frontend..."
BASE_PATH=/ PORT=3000 NODE_ENV=production \
  VITE_CLERK_PUBLISHABLE_KEY="$VITE_CLERK_PUBLISHABLE_KEY" \
  VITE_CLERK_PROXY_URL="$VITE_CLERK_PROXY_URL" \
  pnpm --filter @workspace/platform run build

echo ""
echo "Build complete."
echo "  API:      $REPO_DIR/artifacts/api-server/dist/index.mjs"
echo "  Frontend: $REPO_DIR/artifacts/platform/dist/public"
echo ""
echo "Next steps:"
echo "  1. Copy deploy/nginx.conf to /etc/nginx/sites-available/myorder.fun"
echo "     and reload nginx: sudo nginx -t && sudo systemctl reload nginx"
echo "  2. Restart the API process: pm2 reload alavont-api"
echo "     (or first-time: pm2 start deploy/ecosystem.config.cjs)"
