#!/usr/bin/env bash
# Fresh staging-only backup plus isolated migration-0077 rehearsal.
set -Eeuo pipefail
set +x
umask 077

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
test "${STAGING_0077_REHEARSAL_ACK:-}" = "I_UNDERSTAND_THIS_READS_STAGING_AND_WRITES_ONLY_A_DISPOSABLE_CLONE" || die "Explicit staging rehearsal acknowledgement is required."
SOURCE_CONTAINER="${SOURCE_CONTAINER:-myorder-staging-db-1}"
BACKUP_DIR="${BACKUP_DIR:?Set BACKUP_DIR to a new, empty directory under /home/serveradmin/release-backups}"
POSTGRES_IMAGE_ID="sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
EXPECTED_MIGRATION_SHA="29b98289bd97b1c4781495a93d3d034f03a0daa503a96adfda035d2a3aeecd6b"
FEATURE_SHA="46fc27944bf7069c8e833a9688280849363a8cc6"
FEATURE_TREE="c4b0cab124a8fab09a2087bfdda83c44ea37055f"
MIGRATION_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/db/drizzle/0077_catalogue_inventory_reconciliation.sql"

case "$SOURCE_CONTAINER" in myorder-staging-db-1) ;; *) die "Source must be the pinned staging database container." ;; esac
test -f "$MIGRATION_FILE" || die "The reviewed migration source is missing."
test "$(sha256sum "$MIGRATION_FILE" | awk '{print $1}')" = "$EXPECTED_MIGRATION_SHA" || die "Migration 0077 source checksum mismatch."
test "$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse "$FEATURE_SHA^{tree}")" = "$FEATURE_TREE" || die "Feature source tree mismatch."

BACKUP_ROOT=/home/serveradmin/release-backups
case "$(realpath -m "$BACKUP_DIR")/" in "$BACKUP_ROOT"/*) ;; *) die "Backup path must be beneath the protected release-backups directory." ;; esac
test ! -e "$BACKUP_DIR" || die "Backup directory must be new; existing backups are preserved."
install -d -m 0700 "$BACKUP_DIR"
BACKUP_DIR="$(realpath "$BACKUP_DIR")"

SOURCE_META="$(docker inspect --format '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}|{{json .Config.Env}}' "$SOURCE_CONTAINER")"
case "$SOURCE_META" in "/${SOURCE_CONTAINER}|myorder-staging|db|${POSTGRES_IMAGE_ID}|"*) ;; *) die "Selected database is not the pinned myorder-staging Compose database." ;; esac
case "$SOURCE_META" in *'"POSTGRES_DB=myorder_staging"'*) ;; *) die "Selected database is not configured for myorder_staging." ;; esac
case "$SOURCE_META" in *'"POSTGRES_DB=alavont"'*) die "Production database was detected; refusing." ;; esac
SOURCE_STATE="$(docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}' "$SOURCE_CONTAINER")"
test "$SOURCE_STATE" = "running|healthy" || die "Pinned staging database container is not healthy."

IMAGE_META="$(docker image inspect --format '{{.Id}}|{{.Os}}|{{.Architecture}}' "$POSTGRES_IMAGE_ID")"
test "$IMAGE_META" = "${POSTGRES_IMAGE_ID}|linux|amd64" || die "Disposable PostgreSQL image identity/architecture verification failed."

RESTORE_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RESTORE_CONTAINER="myorder-staging-restore-0077-${RESTORE_SUFFIX}"
RESTORE_NETWORK="myorder-staging-restore-0077-net-${RESTORE_SUFFIX}"
PASSWORD_FILE="$(mktemp "${TMPDIR:-/tmp}/myorder-stage-restore-env.XXXXXX")"
chmod 0600 "$PASSWORD_FILE"
RESTORE_PASSWORD="$(openssl rand -hex 32)"
printf 'POSTGRES_DB=myorder_restore\nPOSTGRES_USER=myorder_restore\nPOSTGRES_PASSWORD=%s\n' "$RESTORE_PASSWORD" > "$PASSWORD_FILE"
unset RESTORE_PASSWORD

cleanup() {
  status=$?
  docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$RESTORE_NETWORK" >/dev/null 2>&1 || true
  rm -f "$PASSWORD_FILE"
  unset SOURCE_META IMAGE_META
  exit "$status"
}
trap cleanup EXIT

SOURCE_LINEAGE="$(docker exec "$SOURCE_CONTAINER" sh -lc 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*)::text || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1790985600002),chr(45)) || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1791358517378),chr(45)) || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1792440000000),chr(45))"')"
EXPECTED_LINEAGE="49|b6491e32ca4e8ae65dfbaab5e33398465fdd747a23765726253852b8f2fc509a|99b25cd808d54c1f5d6d957701b64561bd948a3cb4c06aab0000b047ede66e73|-"
test "$SOURCE_LINEAGE" = "$EXPECTED_LINEAGE" || die "Staging ledger is not the verified pre-0077 lineage."

BACKUP_FILE="$BACKUP_DIR/staging-snapshot.dump"
EVIDENCE_FILE="$BACKUP_DIR/backup-restore-evidence.txt"
docker exec "$SOURCE_CONTAINER" sh -lc 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$BACKUP_FILE"
chmod 0600 "$BACKUP_FILE"
test -s "$BACKUP_FILE" || die "Staging backup is empty."
docker run --rm -v "$BACKUP_DIR:/backup:ro" "$POSTGRES_IMAGE_ID" pg_restore --list /backup/staging-snapshot.dump >/dev/null

docker network create --internal --driver bridge "$RESTORE_NETWORK" >/dev/null
docker run -d --name "$RESTORE_CONTAINER" --network "$RESTORE_NETWORK" --env-file "$PASSWORD_FILE" \
  -v "$BACKUP_DIR:/backup:ro" -v "$MIGRATION_FILE:/migration.sql:ro" "$POSTGRES_IMAGE_ID" >/dev/null
rm -f "$PASSWORD_FILE"

for _ in $(seq 1 60); do
  if docker exec "$RESTORE_CONTAINER" pg_isready -U myorder_restore -d myorder_restore -q; then break; fi
  sleep 1
done
docker exec "$RESTORE_CONTAINER" pg_isready -U myorder_restore -d myorder_restore -q || die "Isolated restore database did not become ready."
docker exec "$RESTORE_CONTAINER" sh -lc 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error /backup/staging-snapshot.dump'
RESTORE_LINEAGE="$(docker exec "$RESTORE_CONTAINER" sh -lc 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*)::text || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1790985600002),chr(45)) || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1791358517378),chr(45)) || chr(124) || coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1792440000000),chr(45))"')"
test "$RESTORE_LINEAGE" = "$EXPECTED_LINEAGE" || die "Restored staging ledger did not match the pre-0077 lineage."

# Apply DDL only to the disposable, internal-only restore. The source database
# is never attached to this network, and no published port is created.
docker exec "$RESTORE_CONTAINER" psql -X -v ON_ERROR_STOP=1 --single-transaction -U myorder_restore -d myorder_restore -f /migration.sql >/dev/null
SCHEMA_OK="$(docker exec "$RESTORE_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U myorder_restore -d myorder_restore -Atc "SELECT to_regclass('public.catalogue_inventory_reconciliation_events') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='catalogue_inventory_reconciliation_immutable' AND NOT tgisinternal) AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='catalogue_product_inventory_model_guard' AND NOT tgisinternal) AND to_regprocedure('public.block_live_inventory_model_change()') IS NOT NULL")"
test "$SCHEMA_OK" = "t" || die "Migration 0077 disposable schema verification failed."
TABLE_COUNT="$(docker exec "$RESTORE_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U myorder_restore -d myorder_restore -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
CHECKSUM="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
docker rm -f "$RESTORE_CONTAINER" >/dev/null
docker network rm "$RESTORE_NETWORK" >/dev/null
if docker inspect "$RESTORE_CONTAINER" >/dev/null 2>&1 || docker network inspect "$RESTORE_NETWORK" >/dev/null 2>&1; then die "Disposable restore resources were not removed."; fi

{
  printf 'source_container=%s\n' "$SOURCE_CONTAINER"
  printf 'source_project=myorder-staging\nsource_database=myorder_staging\n'
  printf 'backup_sha256=%s\n' "$CHECKSUM"
  printf 'restore_image_id=%s\n' "$POSTGRES_IMAGE_ID"
  printf 'restore_project=disposable-staging-0077\nrestore_network_internal=true\n'
  printf 'restore_verified=true\nmigration_0077_rehearsal=passed\nrestore_schema_0077_verified=true\n'
  printf 'migration_count_before_rehearsal=49\napplied_0075=true\napplied_0076=true\napplied_0077_before=false\n'
  printf 'application_table_count=%s\nrestore_removed=true\n' "$TABLE_COUNT"
  printf 'verified_at_utc=%s\n' "$(date -u +%FT%TZ)"
} > "$EVIDENCE_FILE"
chmod 0600 "$EVIDENCE_FILE"
printf 'STAGING_BACKUP_AND_0077_REHEARSAL=VERIFIED\nBACKUP_SHA256=%s\n' "$CHECKSUM"
