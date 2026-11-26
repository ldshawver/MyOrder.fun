# Staging release from GitHub — staging.myorder.fun

Workflow: **Actions → Deploy to staging** (`.github/workflows/deploy-staging.yml`).
It is manual-only, never runs on push or merge, and cannot reach production
credentials, paths or the production Compose project.

## What it does

1. **verify-release** (no credentials): checks the SHA and tree, checks the release
   contains verified-release tooling and descends from the guard's release base,
   and requires the latest completed `CI` run for that exact commit to have succeeded.
2. **deploy** (protected `staging` environment, one at a time):
   Tailscale (`tag:github-actions-staging`) → pinned-host-key SSH →
   `deploy/staging-release-remote.sh` on the host, which:
   - checks the protected env file (regular file, owned by the deploy user, mode 600/400) without reading it;
   - creates or reuses a clean registered worktree `/home/serveradmin/worktrees/staging-release-<sha12>` at the exact commit;
   - runs `node deploy/safe-compose.mjs staging …` from **that release** in verified-release mode:
     `config` (eligibility) → `build` → `migrations` (read-only comparison of the release's migrations with the staging ledger);
   - **preflight** stops here and changes nothing that is running;
   - **deploy** refuses if any migration is pending; otherwise `up api platform` (db, nginx, volumes, project and service names untouched);
   - **migrate-and-deploy** (requires `APPLY_STAGING_MIGRATIONS`): refuses if nothing is pending, takes a fresh `pg_dump` backup into
     `/home/serveradmin/release-backups/staging-release-<sha12>-<time>/` and checks it with `pg_restore --list`, applies migrations, re-validates
     (zero pending), then `up api platform`;
   - waits for `http://127.0.0.1:28081/api/healthz` to report `ok` with the exact release SHA.
3. Confirms `https://staging.myorder.fun/api/healthz` reports the same SHA, and writes the previous SHA, migration status and
   any backup path to the run summary.

Any missing secret, unreachable Tailscale route, host-key mismatch, CI failure, identity mismatch, isolation failure or guard refusal stops the run.

## GitHub settings (one-time)

**Environment `staging`** (Settings → Environments): add required reviewers, and limit deployment branches to `main`.

| Kind | Name | Value |
|---|---|---|
| Secret | `STAGING_TS_OAUTH_CLIENT_ID` / `STAGING_TS_OAUTH_SECRET` | Tailscale OAuth client allowed to create `tag:github-actions-staging` only |
| Secret | `STAGING_VPS_SSH_KEY` | Private key used **only** for staging releases (not the production `VPS_SSH_KEY`) |
| Secret | `STAGING_VPS_KNOWN_HOSTS` | Pinned host key line(s) for the staging host |
| Secret | `STAGING_VPS_HOST_KEY_ALIAS` | The host name used in those known_hosts lines |
| Variable | `STAGING_VPS_TAILSCALE_HOST` | Staging host's Tailscale `100.x` address |
| Variable | `STAGING_VPS_USER` | Deploy user (owner of the staging env file and the worktrees directory) |
| Variable | `STAGING_VPS_PORT` | Optional, default `22` |
| Variable | `MYORDER_STAGING_SOURCE_REPO` | Absolute path of a MyOrder.fun clone on the host used **only** for staging worktrees (not `/opt/alavont`) |
| Variable | `MYORDER_STAGING_ENV_FILE` | Absolute path of the protected staging env file (path only; contents never leave the host) |

**Tailscale ACL:** allow `tag:github-actions-staging` to reach only the staging host on the SSH port.
**Host:** add the staging public key to the deploy user's `authorized_keys`, ideally with
`from="100.64.0.0/10",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty`.
Staging and production share one Docker host, so docker group access is powerful. The guard and the separate, revocable
key are the isolation boundary; a dedicated staging host would be stronger.

## Releasing a commit

1. Get the identity: `git rev-parse <sha>` and `git rev-parse '<sha>^{tree}'`.
2. Run **Deploy to staging** with `action=preflight`. Read the `STAGING_MIGRATION_STATUS` line in the summary.
3. If `pending` is empty: rerun with `action=deploy`.
   If it is not: review those migrations, then rerun with `action=migrate-and-deploy` and `migration_confirmation=APPLY_STAGING_MIGRATIONS`.
4. Approve the `staging` environment when prompted.

## Recovery

- **Failed before `up`:** nothing that is running changed. Fix the cause and rerun.
- **Unhealthy after `up`, no migrations applied:** rerun `action=deploy` with the `STAGING_PREVIOUS_SHA` from the summary, using its tree.
  This only works if that release contains verified-release tooling. For older releases, use the manual steps in `DEPLOY.md`.
- **Migrations were applied:** don't roll the app back blindly, because older code may not match the new schema. Check the migration for
  backward compatibility first. To restore data, use the `STAGING_RELEASE_BACKUP` path with
  `pg_restore --clean --if-exists -d myorder_staging` inside the staging db container, then redeploy the previous release. Get owner approval first.
- Old worktrees (`staging-release-*`) and images (`myorder-*:<sha>`) are kept for rollback. Prune them manually once they're no longer needed.
