#!/usr/bin/env bash
set -euo pipefail

: "${PLAYWRIGHT_BASE_URL:=https://myorder.fun}"
: "${MYORDER_LIVE_E2E:=1}"
export PLAYWRIGHT_BASE_URL MYORDER_LIVE_E2E

required=(
  MYORDER_ADMIN_EMAIL MYORDER_ADMIN_PASSWORD
  MYORDER_CSR_EMAIL MYORDER_CSR_PASSWORD
  MYORDER_CUSTOMER_EMAIL MYORDER_CUSTOMER_PASSWORD
  DATABASE_URL MYORDER_PRODUCT_MASTER_FILE
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
done

# Supervisor credentials are optional; if absent, auth.setup.ts reuses admin credentials for the supervisor session.
mkdir -p artifacts/platform/playwright/.auth
pnpm --filter @workspace/platform exec playwright install chromium
pnpm --filter @workspace/platform e2e:live
./scripts/verify_myorder_pos_live.sh
