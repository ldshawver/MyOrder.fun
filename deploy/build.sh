#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ── Load environment ────────────────────────────────────────────────────────
# Keep a .env file at the repo root on the VPS. build.sh sources it so
# all build-time vars are available before the validate step below.
if [ -f "$REPO_DIR/.env" ]; then
  echo "==> Loading .env file..."
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# ── Normalise env var names ─────────────────────────────────────────────────
# Accept either VITE_CLERK_PUBLISHABLE_KEY or the plain CLERK_PUBLISHABLE_KEY
VITE_CLERK_PUBLISHABLE_KEY="${VITE_CLERK_PUBLISHABLE_KEY:-${CLERK_PUBLISHABLE_KEY:-}}"

# Default proxy URL if not explicitly set
VITE_CLERK_PROXY_URL="${VITE_CLERK_PROXY_URL:-https://myorder.fun/api/__clerk}"

# ── Validate required build-time env vars ───────────────────────────────────
: "${VITE_CLERK_PUBLISHABLE_KEY:?Set VITE_CLERK_PUBLISHABLE_KEY or CLERK_PUBLISHABLE_KEY in .env}"
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
echo "  Frontend: $REPO_DIR/artifacts/platform/dist"
echo ""
echo "Next steps on VPS:"
echo "  sudo cp deploy/nginx.conf /etc/nginx/sites-available/myorder.fun"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo "  pm2 reload alavont-api   # or: pm2 start deploy/ecosystem.config.cjs"
