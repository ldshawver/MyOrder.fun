#!/usr/bin/env bash
set -euo pipefail

# Secret audit guardrail for MyOrder.fun.
# Scans tracked files only, allows documented placeholders/config references,
# and reports only file:line locations so secret values are not printed.

PLACEHOLDER_ALLOW_RE='(changeme|change-me|CHANGE_ME|user:pass|example|placeholder|dummy|test_|sk_test_placeholder|pk_test_placeholder|your_|xxx|redacted|not-a-secret|\$\{[A-Z0-9_]+\}|process\.env\.[A-Z0-9_]+)'
REAL_SECRET_PATTERNS='(OPENAI_API_KEY\s*=\s*sk-[A-Za-z0-9_-]{20,}|STRIPE_SECRET_KEY\s*=\s*sk_(live|test)_[A-Za-z0-9]{16,}|CLERK_SECRET_KEY\s*=\s*sk_live_[A-Za-z0-9]{16,}|TWILIO_AUTH_TOKEN\s*=\s*[A-Fa-f0-9]{32,}|SESSION_SECRET\s*=\s*[A-Za-z0-9_+./=-]{32,}|DATABASE_URL\s*=\s*postgres(ql)?://[^[:space:]@:]+:[^[:space:]@]+@[^[:space:]]+)'

tracked_files="$(git ls-files)"
if [[ -z "$tracked_files" ]]; then
  echo "Secret audit passed"
  exit 0
fi

matches="$(printf '%s\n' "$tracked_files" | xargs -r rg -l "$REAL_SECRET_PATTERNS" || true)"
if [[ -n "$matches" ]]; then
  unsafe_locations=""
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    while IFS=: read -r line _rest; do
      [[ -z "$line" ]] && continue
      line_text="$(sed -n "${line}p" "$file")"
      if ! printf '%s\n' "$line_text" | rg -q "$PLACEHOLDER_ALLOW_RE"; then
        unsafe_locations+="${file}:${line}"$'\n'
      fi
    done < <(rg -n "$REAL_SECRET_PATTERNS" "$file" || true)
  done <<< "$matches"

  if [[ -n "$unsafe_locations" ]]; then
    printf 'Potential real secrets found at these locations (values suppressed):\n%s' "$unsafe_locations" >&2
    exit 1
  fi
fi

echo "Secret audit passed"
