#!/bin/bash
# Mac Studio foreground diagnostic/manual launcher.
# PM2 (ecosystem.config.js) is the authoritative persistent launch method.
# Never run this script while PM2 is running; both bind the same port (3100 by
# default).
# Run: bash ~/MyOrder.fun/deploy/print-bridge/start-mac.sh

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "Missing deploy/print-bridge/.env" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  env_mode="$(stat -f '%Lp' .env 2>/dev/null || true)"
else
  env_mode="$(stat -c '%a' .env 2>/dev/null || true)"
fi
if [[ "$env_mode" != "600" ]]; then
  echo "deploy/print-bridge/.env must have permissions 600" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${PRINT_BRIDGE_API_KEY:?PRINT_BRIDGE_API_KEY is required in .env}"
: "${PRINTER_NAME:?PRINTER_NAME is required in .env}"

# The Mac bridge is CUPS-only. Do not permit stale local environment values to
# reactivate direct-socket or raw-USB fallback transports.
unset DIRECT_PRINTER_IP
unset DIRECT_PRINTER_PORT
export DIRECT_PRINTER_IP=""
export DIRECT_PRINTER_PORT=""
unset USB_DEVICE
export USB_DEVICE=""

echo "Starting print bridge → configured CUPS queue: $PRINTER_NAME"
node server.js
