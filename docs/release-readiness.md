# Production Release Readiness

The production Compose project is **`deploy`** and its database volume is
**`deploy_postgres_data`**. The persistent deployment tree is
`/opt/alavont`. These are deliberate, fail-closed invariants in the deployment
workflow; do not use Compose project `alavont`, whose database volume is a
different, uninitialized database.

## Backup, restore, and migration rehearsal

Run this only from a clean release candidate and only with an explicitly named
source database container. The source operation is `pg_dump` only; the restore
and migrations target an isolated temporary Postgres container.

```bash
backup_dir="$(mktemp -d /tmp/myorder-release-backup.XXXXXX)"
export RELEASE_RESTORE_ACK=I_UNDERSTAND_THIS_IS_A_RESTORE_REHEARSAL
export SOURCE_CONTAINER=deploy-db-1
export BACKUP_DIR="$backup_dir"
export RESTORE_PASSWORD='use-a-new-disposable-test-password'
bash scripts/release/backup-restore-rehearsal.sh
```

Use the emitted restore port only with the disposable credentials supplied to
the preceding command, then rehearse the candidate migrations:

```bash
export RELEASE_MIGRATION_REHEARSAL_ACK=I_UNDERSTAND_THIS_MUTATES_ONLY_THE_RESTORE
export RESTORE_CONTAINER='myorder-release-restore-...'
export DATABASE_URL='postgresql://myorder_restore:use-a-new-disposable-test-password@127.0.0.1:PORT/myorder_restore'
export EVIDENCE_FILE="$backup_dir/backup-restore-evidence.txt"
bash scripts/release/rehearse-migrations.sh
```

Retain the evidence file and backup until the approved release is stable. When
the rehearsal is complete, remove only the specifically named temporary restore
container. `deploy-db-1` may be the read-only `SOURCE_CONTAINER`; never use it
as the restore target.

## Production deployment approval gate

Production deployment requires explicit approval. Before approving it:

1. Confirm the released commit, image tags, and `/opt/alavont/deploy/nginx/nginx.conf` are correct.
2. Confirm the live `deploy-db-1` mount is `deploy_postgres_data`.
3. Complete and retain a successful backup/restore/migration rehearsal.
4. Confirm staging workflows with non-production credentials.
5. Keep the current production image SHA available for application rollback.

Database migrations are not automatically reversible. If an application
rollback is incompatible with an applied migration, restore the verified backup
into a controlled recovery environment first; do not overwrite the production
database without a separately approved recovery procedure.

# Compose health-check topology

Both production and staging use container-local probes with binaries already
included in their images. PostgreSQL uses `pg_isready`; the Node API uses its
built-in `fetch` against `127.0.0.1:8080/healthz`; the platform nginx listens
on `127.0.0.1:3000`; and the edge nginx listens on `127.0.0.1:80`.

The edge nginx service waits for healthy API and platform services, rather than
merely started containers. Use a 10-second interval, 5-second timeout, ten
retries, and a 10-second startup period for nginx platform/edge probes (the API
retains its 15-second startup period). Do not substitute port 80 for the
platform probe: port 80 belongs to the edge nginx container, not the platform
container.
