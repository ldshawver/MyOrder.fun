#!/usr/bin/env bash
# Creates a consistent, read-only backup of an explicitly named Postgres
# container and restores it only into a disposable, isolated container.
set -Eeuo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

test "${RELEASE_RESTORE_ACK:-}" = "I_UNDERSTAND_THIS_IS_A_RESTORE_REHEARSAL" || die "Set RELEASE_RESTORE_ACK to run."
SOURCE_CONTAINER="${SOURCE_CONTAINER:?Set SOURCE_CONTAINER explicitly (for example deploy-db-1)}"
BACKUP_DIR="${BACKUP_DIR:?Set BACKUP_DIR to an empty, restricted directory}"
RESTORE_CONTAINER="${RESTORE_CONTAINER:-myorder-release-restore-$(date +%s)}"
RESTORE_DB="${RESTORE_DB:-myorder_restore}"
RESTORE_USER="${RESTORE_USER:-myorder_restore}"
RESTORE_PASSWORD="${RESTORE_PASSWORD:?Set a disposable restore password}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

case "${RESTORE_CONTAINER}" in myorder-release-restore-*) ;; *) die "RESTORE_CONTAINER must start with myorder-release-restore-" ;; esac
test "${SOURCE_CONTAINER}" != "${RESTORE_CONTAINER}" || die "Source and restore containers must differ."
docker inspect "${SOURCE_CONTAINER}" >/dev/null

umask 077
mkdir -p "${BACKUP_DIR}"
test -z "$(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" || die "BACKUP_DIR must be empty."
BACKUP_FILE="${BACKUP_DIR}/production-snapshot.dump"
EVIDENCE_FILE="${BACKUP_DIR}/backup-restore-evidence.txt"

cleanup_on_error() {
  status=$?
  if [ "${status}" -ne 0 ]; then docker rm -f "${RESTORE_CONTAINER}" >/dev/null 2>&1 || true; fi
  exit "${status}"
}
trap cleanup_on_error EXIT

# pg_dump custom format takes a consistent snapshot and never writes to the
# source database. Credentials remain inside the source container.
docker exec "${SOURCE_CONTAINER}" sh -lc 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "${BACKUP_FILE}"
test -s "${BACKUP_FILE}" || die "Backup is empty."

# Validate archive readability before creating the restore target.
docker run --rm -v "${BACKUP_DIR}:/backup:ro" "${POSTGRES_IMAGE}" \
  pg_restore --list "/backup/$(basename "${BACKUP_FILE}")" >/dev/null

docker run -d --name "${RESTORE_CONTAINER}" \
  -e "POSTGRES_DB=${RESTORE_DB}" \
  -e "POSTGRES_USER=${RESTORE_USER}" \
  -e "POSTGRES_PASSWORD=${RESTORE_PASSWORD}" \
  -p 127.0.0.1::5432 \
  -v "${BACKUP_DIR}:/backup:ro" \
  "${POSTGRES_IMAGE}" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${RESTORE_CONTAINER}" pg_isready -U "${RESTORE_USER}" -d "${RESTORE_DB}" -q; then break; fi
  sleep 1
done
docker exec "${RESTORE_CONTAINER}" pg_isready -U "${RESTORE_USER}" -d "${RESTORE_DB}" -q || die "Restore database did not become ready."
docker exec "${RESTORE_CONTAINER}" sh -lc 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error "/backup/production-snapshot.dump"'

MIGRATIONS="$(docker exec "${RESTORE_CONTAINER}" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from drizzle.__drizzle_migrations"')"
TABLES="$(docker exec "${RESTORE_CONTAINER}" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from pg_tables where schemaname not in ('\''pg_catalog'\'', '\''information_schema'\'')"')"
RESTORE_PORT="$(docker port "${RESTORE_CONTAINER}" 5432/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
test -n "${RESTORE_PORT}" || die "Could not determine isolated restore port."

{
  echo "source_container=${SOURCE_CONTAINER}"
  echo "backup_sha256=$(sha256sum "${BACKUP_FILE}" | awk '{print $1}')"
  echo "restore_container=${RESTORE_CONTAINER}"
  echo "restore_port=${RESTORE_PORT}"
  echo "migration_count_before_rehearsal=${MIGRATIONS}"
  echo "application_table_count=${TABLES}"
  echo "verified_at_utc=$(date -u +%FT%TZ)"
} > "${EVIDENCE_FILE}"

trap - EXIT
echo "Backup and isolated restore verified. Evidence: ${EVIDENCE_FILE}"
echo "Restore container: ${RESTORE_CONTAINER}; port: ${RESTORE_PORT}; migrations: ${MIGRATIONS}"
