#!/usr/bin/env bash
# Applies the candidate journal only to the disposable restore container made
# by backup-restore-rehearsal.sh. It cannot target a production container.
set -Eeuo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

test "${RELEASE_MIGRATION_REHEARSAL_ACK:-}" = "I_UNDERSTAND_THIS_MUTATES_ONLY_THE_RESTORE" || die "Set RELEASE_MIGRATION_REHEARSAL_ACK to run."
RESTORE_CONTAINER="${RESTORE_CONTAINER:?Set RESTORE_CONTAINER explicitly}"
DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL to the isolated restore database}"
EVIDENCE_FILE="${EVIDENCE_FILE:?Set EVIDENCE_FILE inside the restricted backup directory}"
case "${RESTORE_CONTAINER}" in myorder-release-restore-*) ;; *) die "RESTORE_CONTAINER must be a disposable restore container." ;; esac
docker inspect "${RESTORE_CONTAINER}" >/dev/null

EXPECTED="$(node -p "require('./lib/db/drizzle/meta/_journal.json').entries.length")"
before="$(docker exec "${RESTORE_CONTAINER}" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from drizzle.__drizzle_migrations"')"

DB_SSL=false DATABASE_URL="${DATABASE_URL}" pnpm --filter @workspace/db db:validate-migrations
DB_SSL=false DATABASE_URL="${DATABASE_URL}" pnpm --filter @workspace/db db:migrate
DB_SSL=false DATABASE_URL="${DATABASE_URL}" pnpm --filter @workspace/db db:validate-migrations

after="$(docker exec "${RESTORE_CONTAINER}" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from drizzle.__drizzle_migrations"')"
test "${after}" = "${EXPECTED}" || die "Expected ${EXPECTED} applied migrations; found ${after}."

{
  echo "candidate_commit=$(git rev-parse HEAD)"
  echo "migration_count_before=${before}"
  echo "migration_count_after=${after}"
  echo "expected_migration_count=${EXPECTED}"
  echo "migration_rehearsal_verified_at_utc=$(date -u +%FT%TZ)"
} >> "${EVIDENCE_FILE}"

echo "Migration rehearsal passed: ${before} -> ${after}. Evidence: ${EVIDENCE_FILE}"
