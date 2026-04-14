#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Load a .env file from the repo root if it exists (useful on the VPS)
if [ -f "$REPO_DIR/.env" ]; then
  echo "==> Loading .env file..."
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# Validate required build-time env vars
: "${VITE_CLERK_PUBLISHABLE_KEY:?Need to set VITE_CLERK_PUBLISHABLE_KEY}"
: "${VITE_CLERK_PROXY_URL:?Need to set VITE_CLERK_PROXY_URL}"

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

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
