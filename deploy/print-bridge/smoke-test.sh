#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${1:-${PRINT_BRIDGE_URL:-http://127.0.0.1:3100}}"
API_KEY="${2:-${PRINT_BRIDGE_API_KEY:-}}"
QUEUE="${3:-${PRINTER_NAME:-receipt}}"
ROLE="${4:-receipt}"

if [[ -z "${API_KEY}" ]]; then
  echo "Usage: bash smoke-test.sh <bridge-url> <api-key> [queue] [role]"
  echo "Example: bash smoke-test.sh http://100.83.99.2:3100 abc123 receipt receipt"
  exit 1
fi

echo "== healthz =="
curl -fsS "${BRIDGE_URL}/healthz"
echo
echo

echo "== authenticated health =="
curl -fsS -H "x-api-key: ${API_KEY}" "${BRIDGE_URL}/health"
echo
echo

echo "== printers =="
curl -fsS -H "x-api-key: ${API_KEY}" "${BRIDGE_URL}/printers"
echo
echo

echo "== print =="
PAYLOAD="$(printf '\033@=== MYORDER BRIDGE TEST ===\nQueue: %s\n%s\n\n\n\035V1' "${QUEUE}" "$(date -Is)" | base64 | tr -d '\n')"
curl -fsS \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d "{\"role\":\"${ROLE}\",\"printer\":\"${QUEUE}\",\"payloadBase64\":\"${PAYLOAD}\",\"copies\":1}" \
  "${BRIDGE_URL}/print"
echo
echo
echo "Smoke test request completed. Confirm the physical receipt printed."
