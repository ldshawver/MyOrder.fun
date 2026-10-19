# Guarded staging release for catalogue inventory reconciliation

This path is exclusively for staging validation of merged application commit
`46fc27944bf7069c8e833a9688280849363a8cc6`, tree
`c4b0cab124a8fab09a2087bfdda83c44ea37055f`. It does not modify
`safe-compose.mjs` or the production release controller.

The candidate API, Platform, and migrator images must be supplied as immutable
`myorder-{api,platform,migrate}@sha256:…` references in
`MYORDER_STAGING_FEATURE_{API,PLATFORM,MIGRATE}_IMAGE`. The controller verifies
the local image ID, RepoDigest, Linux/amd64 architecture, and both revision
labels against the merged application commit. It accepts no mutable tags or
other source revisions. The exact image digest set is recorded by the operator
when the candidate images have been built; the tool never builds or pulls them.

The only database migration action is migration 0077. Before that action, take
a **new** staging snapshot and rehearse restoration plus migration 0077 against
an internal-only disposable PostgreSQL clone:

```sh
set +x
umask 077
export STAGING_0077_REHEARSAL_ACK=I_UNDERSTAND_THIS_READS_STAGING_AND_WRITES_ONLY_A_DISPOSABLE_CLONE
export BACKUP_DIR=/home/serveradmin/release-backups/myorder-staging-0077-$(date -u +%Y%m%dT%H%M%SZ)
scripts/release/staging-0077-backup-restore-rehearsal.sh
```

The rehearsal reads only `myorder-staging-db-1`, verifies its 49-row pre-0077
ledger and exact 0075/0076 hashes, writes a mode-0600 custom-format backup,
restores it on a Docker `--internal` network with no published port, applies
the checked 0077 SQL only to that clone, verifies the resulting schema, then
removes the clone and network. It preserves the backup and writes mode-0600
evidence. The staging migration gate rejects evidence older than one hour,
evidence from another target, checksum mismatch, missing rehearsal proof, or
any migration drift.

For later operator-authorized live staging work, use a clean registered
worktree descended from the exact feature commit, set the protected staging
environment-file path and the three immutable image references, and run:

```sh
node deploy/staging-feature-release.mjs verify
node deploy/staging-feature-release.mjs migrate
node deploy/staging-feature-release.mjs up
```

`verify` is read-only. `migrate` requires fresh rehearsal evidence and performs
only the forward migration. `up` uses `--pull never --no-build`, touches only
the API and Platform services, and requires 0077 already applied. `rollback`
restores only the API and Platform images to the verified 40fcc staging
baseline; it deliberately leaves the database migration forward-only. The
existing staging nginx, DB, deployment controller, all production images,
production workflows, secrets, and data remain outside this path.

This documentation and tooling do not authorize a live staging release or
inventory reconciliation.
