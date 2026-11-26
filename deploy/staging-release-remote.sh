#!/usr/bin/env bash
# Runs ON the staging host, sent over the pinned SSH session by
# .github/workflows/deploy-staging.yml. It only prepares a clean, registered
# release worktree and then calls deploy/safe-compose.mjs (from that exact
# release) in verified-release mode. All environment, database, network,
# container and image checks stay in safe-compose.mjs.
#
# Usage: staging-release-remote.sh <preflight|deploy|migrate-and-deploy|bootstrap-synthetic> <sha> <tree> <source-repo> <env-file> [migration-confirmation]
set -euo pipefail
umask 077

ACTION="${1:-}"; SHA="${2:-}"; TREE="${3:-}"; SOURCE_REPO="${4:-}"; ENV_FILE="${5:-}"; MIGRATION_CONFIRMATION="${6:-}"
WORKTREES_ROOT="/srv/myorder-staging/worktrees"
LOCAL_HEALTH_URL="http://127.0.0.1:28081/api/healthz"

fail() { echo "::error::$*" >&2; exit 1; }

case "$ACTION" in preflight|deploy|migrate-and-deploy|bootstrap-synthetic) ;; *) fail "Unknown action";; esac
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "Release SHA must be a full 40-character commit SHA"
[[ "$TREE" =~ ^[0-9a-f]{40}$ ]] || fail "Release tree must be a full 40-character tree SHA"
[[ "$SOURCE_REPO" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "Staging source repository path is invalid"
[[ "$ENV_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "Staging environment file path is invalid"
case "$SOURCE_REPO$ENV_FILE" in *..*) fail "Paths must not contain ..";; esac
case "$SOURCE_REPO" in /opt/alavont|/opt/alavont/*) fail "Refusing to use the production checkout";; esac
case "$ENV_FILE" in /opt/alavont/*) fail "Refusing to use a production environment file";; esac
if [ "$ACTION" = "migrate-and-deploy" ] && [ "$MIGRATION_CONFIRMATION" != "APPLY_STAGING_MIGRATIONS" ]; then fail "migrate-and-deploy requires the explicit migration confirmation"; fi
if [ "$ACTION" = "bootstrap-synthetic" ] && [ "$MIGRATION_CONFIRMATION" != "BOOTSTRAP_SYNTHETIC_STAGING" ]; then fail "bootstrap-synthetic requires the explicit synthetic bootstrap confirmation"; fi
if [ "$ACTION" != "migrate-and-deploy" ] && [ "$ACTION" != "bootstrap-synthetic" ] && [ -n "$MIGRATION_CONFIRMATION" ]; then fail "A migration confirmation is only accepted with a mutating staging action"; fi

# ── Node.js for the guard. Non-interactive SSH sessions do not load the deploy
# user's shell profile, so a Node installed with nvm (or in a user bin dir) is not
# on PATH. Resolve it explicitly from fixed, user-owned or system locations.
if ! command -v node >/dev/null 2>&1; then
  for dir in /usr/local/bin /usr/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [ -x "$dir/node" ]; then PATH="$dir:$PATH"; break; fi
  done
fi
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  nvm_node_bin="$(find "$HOME/.nvm/versions/node" -mindepth 3 -maxdepth 3 -path '*/bin/node' \( -type f -o -type l \) 2>/dev/null | sort -V | tail -1)"
  if [ -n "$nvm_node_bin" ] && [ -x "$nvm_node_bin" ]; then PATH="$(dirname -- "$nvm_node_bin"):$PATH"; fi
fi
export PATH
command -v node >/dev/null 2>&1 || fail "Node.js is not available to $(id -un) in a non-interactive SSH session; install Node.js 22 or newer system-wide or under ~/.nvm for this user"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "Node.js $(node --version) is too old for the staging guard; Node.js 22 or newer is required"
echo "Staging guard Node.js: $(node --version)"

# ── Protected staging environment file (contents are never read or printed here)
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "Staging environment file is missing or is not a regular file"
[ "$(stat -c %u "$ENV_FILE")" = "$(id -u)" ] || fail "Staging environment file must be owned by the deploy user"
mode="$(stat -c %a "$ENV_FILE")"
case "$mode" in 600|400) ;; *) fail "Staging environment file mode is $mode; it must be 600 or 400";; esac

# ── Source repository and exact release checkout
git -C "$SOURCE_REPO" rev-parse --git-dir >/dev/null 2>&1 || fail "Staging source repository is not a Git repository"
origin="$(git -C "$SOURCE_REPO" remote get-url origin | tr 'A-Z' 'a-z')"
[[ "$origin" =~ github\.com[:/]ldshawver/myorder\.fun(\.git)?$ ]] || fail "Staging source repository origin is not ldshawver/MyOrder.fun"
git -C "$SOURCE_REPO" fetch --quiet --no-tags origin "$SHA" || fail "Could not fetch the release commit from origin"
[ "$(git -C "$SOURCE_REPO" rev-parse "$SHA^{commit}")" = "$SHA" ] || fail "Release commit is unavailable"
[ "$(git -C "$SOURCE_REPO" rev-parse "$SHA^{tree}")" = "$TREE" ] || fail "Release tree does not match the selected commit"

WT="$WORKTREES_ROOT/staging-release-${SHA:0:12}"
mkdir -p -- "$WORKTREES_ROOT"
[ "$(realpath -- "$WORKTREES_ROOT")" = "$WORKTREES_ROOT" ] && [ -O "$WORKTREES_ROOT" ] || fail "Staging worktree directory must be owned by the deployment user and use its canonical path"
[ ! -L "$WT" ] || fail "Refusing a symlinked release worktree"
if [ -e "$WT" ]; then
  git -C "$SOURCE_REPO" worktree list --porcelain | grep -qxF "worktree $WT" || fail "Existing $WT is not a registered worktree of the staging source repository"
else
  git -C "$SOURCE_REPO" worktree add --quiet --detach "$WT" "$SHA"
fi
cd "$WT"
[ "$(git rev-parse HEAD)" = "$SHA" ] || fail "Release worktree HEAD is not the release commit"
[ "$(git rev-parse 'HEAD^{tree}')" = "$TREE" ] || fail "Release worktree tree does not match"
[ -z "$(git status --porcelain=v1)" ] || fail "Release worktree is not clean"
grep -q 'RELEASE_MODE_VALUE = "verified-release"' deploy/safe-compose.mjs || fail "This release predates verified-release staging tooling; update it from main"

export DEPLOY_SHA="$SHA" DEPLOY_TREE="$TREE" MYORDER_STAGING_ENV_FILE="$ENV_FILE" MYORDER_STAGING_RELEASE_MODE="verified-release"
unset MYORDER_STAGING_MIGRATION_CONFIRMATION MYORDER_API_IMAGE MYORDER_PLATFORM_IMAGE MYORDER_MIGRATE_IMAGE PRODUCTION_DEPLOY_CONFIRMATION
guard() { node deploy/safe-compose.mjs staging "$@"; }

previous="$(curl -fsS --max-time 10 "$LOCAL_HEALTH_URL" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sha||"unknown"))}catch{process.stdout.write("unknown")}})' || true)"
echo "STAGING_PREVIOUS_SHA=${previous:-unknown}"

if [ "$ACTION" = "bootstrap-synthetic" ]; then
  echo "== Guard: initialize an empty staging project with synthetic data only"
  guard bootstrap-synthetic
  echo "== Verify staging health and release identity"
  for _ in $(seq 1 30); do
    body="$(curl -fsS --max-time 5 "$LOCAL_HEALTH_URL" 2>/dev/null || true)"
    if printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.status==="ok"&&j.sha===process.argv[1]?0:1)}catch{process.exit(1)}})' "$SHA"; then
      echo "STAGING_DEPLOYED_SHA=$SHA previous=${previous:-unknown}"
      exit 0
    fi
    sleep 4
  done
  fail "Synthetic staging bootstrap did not report healthy with sha $SHA"
fi

echo "== Guard: release eligibility (read-only)"
guard config
echo "== Guard: build release images from the clean checkout"
guard build
echo "== Guard: compare release migrations with the staging ledger (read-only)"
status_line="$(guard migrations | grep '^STAGING_MIGRATION_STATUS=' | tail -1)"
[ -n "$status_line" ] || fail "Migration status is unavailable"
echo "$status_line"
pending="$(printf '%s' "${status_line#STAGING_MIGRATION_STATUS=}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).pending.join(",")))')"

if [ "$ACTION" = "preflight" ]; then
  echo "STAGING_PREFLIGHT_OK=$SHA pending_migrations=${pending:-none}"
  exit 0
fi

if [ -n "$pending" ]; then
  [ "$ACTION" = "migrate-and-deploy" ] || fail "Release needs pending staging migrations ($pending). Review them, then rerun with action migrate-and-deploy and the migration confirmation."
  echo "== Guard: backup, then apply pending staging migrations: $pending"
  MYORDER_STAGING_MIGRATION_CONFIRMATION="$MIGRATION_CONFIRMATION" guard migrate
else
  [ "$ACTION" != "migrate-and-deploy" ] || fail "No pending staging migrations; rerun with action deploy"
fi

echo "== Guard: start release api and platform"
guard up api platform

echo "== Verify staging health and release identity"
for _ in $(seq 1 30); do
  body="$(curl -fsS --max-time 5 "$LOCAL_HEALTH_URL" 2>/dev/null || true)"
  if printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.status==="ok"&&j.sha===process.argv[1]?0:1)}catch{process.exit(1)}})' "$SHA"; then
    echo "STAGING_DEPLOYED_SHA=$SHA previous=${previous:-unknown}"
    exit 0
  fi
  sleep 4
done
fail "Staging did not report healthy with sha $SHA. Previous release was ${previous:-unknown}; see deploy/STAGING-RELEASE.md for recovery."
