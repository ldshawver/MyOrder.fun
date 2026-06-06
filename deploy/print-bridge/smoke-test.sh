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
if ! curl -fsS "${BRIDGE_URL}/healthz"; then
  echo "healthz unavailable; continuing with authenticated /health"
fi
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
TEXT="$(printf '\033@=== MYORDER BRIDGE TEST ===\nQueue: %s\n%s\n\n\n\035V1' "${QUEUE}" "$(date '+%Y-%m-%dT%H:%M:%S%z')" )"
PAYLOAD="$(printf '%s' "${TEXT}" | base64 | tr -d '\n')"
BODY="$(node -e 'const [role, queue, text, payloadBase64] = process.argv.slice(1); process.stdout.write(JSON.stringify({ role, printer: queue, printerName: queue, text, payloadBase64, copies: 1 }));' "${ROLE}" "${QUEUE}" "${TEXT}" "${PAYLOAD}")"
curl -fsS \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d "${BODY}" \
  "${BRIDGE_URL}/print"
echo
echo
echo "Smoke test request completed. Confirm the physical printout."
