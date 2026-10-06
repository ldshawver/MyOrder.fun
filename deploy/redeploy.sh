#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test "$repo_root" = "/opt/alavont" || { echo "Refusing: run from the production checkout /opt/alavont" >&2; exit 1; }
test "$(pwd -P)" = "$repo_root" || { echo "Refusing: run from /opt/alavont" >&2; exit 1; }
test "${DEPLOY_PRODUCTION_CONFIRMATION:-}" = "DEPLOY-PRODUCTION" || { echo "Refusing: set DEPLOY_PRODUCTION_CONFIRMATION=DEPLOY-PRODUCTION" >&2; exit 1; }
test -n "${DEPLOY_CHANGE_ID:-}" || { echo "Refusing: DEPLOY_CHANGE_ID is required" >&2; exit 1; }
export DEPLOY_SHA="${DEPLOY_SHA:-$(git -C "$repo_root" rev-parse HEAD)}"
export PRODUCTION_DEPLOY_CONFIRMATION=DEPLOY-PRODUCTION

node deploy/safe-compose.mjs production build --authorize-production
node deploy/safe-compose.mjs production up db --authorize-production
node deploy/safe-compose.mjs production migrate --authorize-production
node deploy/safe-compose.mjs production up api platform nginx --authorize-production
