#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
env_file=".env.staging-sticker"
if [[ ! -f "$env_file" ]]; then
  umask 077
  touch "$env_file"
  echo "Created $env_file with mode 600. Populate it through the approved secret manager, then rerun." >&2
  exit 2
fi
mode="$(stat -f '%Lp' "$env_file")"
[[ "$mode" == "600" ]] || { echo "$env_file must have mode 600" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source "$env_file"
set +a
: "${STAGING_MYORDER_API_URL:?required}"
: "${STAGING_STICKER_BRIDGE_ID:?required}"
: "${STAGING_STICKER_BRIDGE_SECRET:?required}"
[[ "$STAGING_MYORDER_API_URL" == https://* ]] || { echo "Staging API must use HTTPS" >&2; exit 1; }
[[ "$STAGING_MYORDER_API_URL" != *production* ]] || { echo "Production endpoint prohibited" >&2; exit 1; }
lpstat -p MARKLIFE_X2 -l >/dev/null
lpstat -a MARKLIFE_X2 | grep -q "accepting requests"
lpstat -v MARKLIFE_X2 | grep -Fq "usb://MARKLIFE/X2?location=8343000"
pm2 startOrReload ecosystem.staging-sticker.config.js --only myorder-staging-marklife-pull
pm2 save
echo "Staging MARKLIFE outbound bridge installed; no print job was created or submitted."
