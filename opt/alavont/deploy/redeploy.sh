#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
exec bash "$repo_root/deploy/redeploy.sh" "$@"
