#!/usr/bin/env bash
set -euo pipefail

# Secret audit guardrail for MyOrder.fun.
# Uses ripgrep instead of noisy recursive grep scans, permits documented
# placeholders, and fails on real-looking tokens that should never be committed.

PLACEHOLDER_ALLOW_RE='(changeme|change-me|example|placeholder|dummy|test_|sk_test_|pk_test_|your_|xxx|redacted|not-a-secret)'
REAL_SECRET_PATTERNS='(sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})'

matches="$(rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!pnpm-lock.yaml' "$REAL_SECRET_PATTERNS" . || true)"
if [[ -n "$matches" ]]; then
  filtered="$(printf '%s\n' "$matches" | rg -v "$PLACEHOLDER_ALLOW_RE" || true)"
  if [[ -n "$filtered" ]]; then
    printf 'Potential real secrets found:\n%s\n' "$filtered" >&2
    exit 1
  fi
fi

echo "Secret audit passed"
