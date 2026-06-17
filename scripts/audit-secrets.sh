#!/usr/bin/env bash
set -euo pipefail

# Scan committed files for real-looking secret values. This intentionally does
# not flag safe references such as process.env.OPENAI_API_KEY, ${DATABASE_URL},
# or placeholder values in example/config files.

EXCLUDED_FILES=(
  ".env.example"
  "deploy/.env.example"
  "deploy/docker-compose.yml"
  ".github/workflows/repo-audit.yml"
)

is_excluded_file() {
  local file="$1"
  for excluded in "${EXCLUDED_FILES[@]}"; do
    [[ "$file" == "$excluded" ]] && return 0
  done
  [[ "$file" == node_modules/* || "$file" == dist/* || "$file" == build/* || "$file" == coverage/* ]] && return 0
  return 1
}

is_placeholder() {
  local value="$1"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  value="${value%,}"

  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$ ]] && return 0
  [[ "$value" =~ ^(changeme|change-me|change_me|replace-me|replace_me|placeholder|example|example-value|your-.+|test|dummy|dev-secret|not-a-secret)$ ]] && return 0
  [[ "$value" =~ ^(<[^>]+>|\[[^]]+\])$ ]] && return 0
  return 1
}

looks_real_database_url() {
  local value="$1"
  [[ "$value" =~ YOUR_|your_|user:pass@|user:password@|postgres:postgres@127\.0\.0\.1|postgres:postgres@localhost ]] && return 1
  [[ "$value" =~ ^postgres(ql)?://[^:/[:space:]]+:[^@/[:space:]]+@[^[:space:]]+/.+ ]]
}

looks_real_secret() {
  local key="$1"
  local value="$2"

  value="${value%%#*}"
  value="${value%%[[:space:]]*}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  value="${value%,}"

  is_placeholder "$value" && return 1

  case "$key" in
    OPENAI_API_KEY)
      [[ "$value" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]
      ;;
    STRIPE_SECRET_KEY|CLERK_SECRET_KEY)
      [[ "$value" =~ ^sk_(live|test)_[A-Za-z0-9_-]{16,}$ ]]
      ;;
    TWILIO_AUTH_TOKEN)
      [[ "$value" =~ ^[A-Fa-f0-9]{32,}$ || "$value" =~ ^[A-Za-z0-9_-]{40,}$ ]]
      ;;
    SESSION_SECRET)
      [[ ${#value} -ge 32 && "$value" =~ [A-Za-z] && "$value" =~ [0-9] ]]
      ;;
    DATABASE_URL)
      looks_real_database_url "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

# Keep git ls-files in this script so the audit is explicitly limited to
# committed/tracked content, while git grep performs the efficient prefilter.
git ls-files >/dev/null

failures=()
database_url_regex="postgres(ql)?://[^[:space:]\`\"']+"
while IFS=: read -r file line_number line; do
  [[ -z "${file:-}" || -z "${line_number:-}" ]] && continue
  is_excluded_file "$file" && continue

  # URL credentials can appear without a DATABASE_URL key.
  if [[ "$line" =~ $database_url_regex ]]; then
    database_url="${BASH_REMATCH[1]}"
    if looks_real_database_url "$database_url"; then
      failures+=("$file:$line_number: possible committed PostgreSQL URL with credentials")
      continue
    fi
  fi

  # Only assignments are suspicious; bare env var names, process.env.NAME, and
  # docker-compose ${NAME} interpolation do not match this branch.
  if [[ "$line" =~ (^|[^A-Za-z0-9_])(OPENAI_API_KEY|DATABASE_URL|SESSION_SECRET|STRIPE_SECRET_KEY|TWILIO_AUTH_TOKEN|CLERK_SECRET_KEY)[[:space:]]*[:=][[:space:]]*([^[:space:]]+) ]]; then
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    if looks_real_secret "$key" "$value"; then
      failures+=("$file:$line_number: possible committed value for $key")
    fi
  fi
done < <(git grep -nI -E 'OPENAI_API_KEY|DATABASE_URL|SESSION_SECRET|STRIPE_SECRET_KEY|TWILIO_AUTH_TOKEN|CLERK_SECRET_KEY|postgres(ql)?://' -- . ':(exclude)node_modules/**' ':(exclude)dist/**' ':(exclude)build/**' ':(exclude)coverage/**' || true)

if ((${#failures[@]} > 0)); then
  printf 'Secret audit failed. Real-looking committed secret values were found:\n' >&2
  printf '  %s\n' "${failures[@]}" >&2
  exit 1
fi

printf 'Secret audit passed: no real-looking committed secret values found.\n'
