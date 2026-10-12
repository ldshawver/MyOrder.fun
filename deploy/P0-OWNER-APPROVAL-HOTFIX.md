# P0 owner approval hotfix release procedure

## Release identity and migration scope

The accepted authorization-code candidate is `ad2d7e6487316e0be28ba3c8423b450e506af51e`, based on production API commit `579cce225c0f9e7bee41a4c226d43e5ba5c86606`. Production's Drizzle ledger ends at the 0067 prefix. `deploy/hotfix-owner-approval.sql` is the only database change for this release. It is a standalone transaction, writes marker `public.myorder_hotfix_migrations / p0_owner_approval_provenance`, and leaves the Drizzle ledger unchanged. The final release SHA must come from the reviewed release record; use the same full SHA for source checkout, build argument, image tag, running-container label, and API health response.

The committed `0068_print_jobs_document_job_types` migration is deferred. Do not build or run the `migrate` Compose service, invoke `drizzle-kit migrate`, or use the normal deploy workflow for this hotfix. A future release must restore the pending print migration and add an idempotent Drizzle reconciliation migration for the owner provenance columns after it.

## Owner subject configuration

The sole accepted setting is `MYORDER_OWNER_CLERK_ID`. It must contain the designated owner's immutable Clerk user subject (`user_…`), obtained by an operator authenticated to the production Clerk instance. In the Clerk Dashboard, open the designated owner's user profile and copy its user ID. Verify that exact ID through Clerk's authenticated Backend API `GET /v1/users/{user_id}`; the returned `id` must equal the copied ID. Do not derive it from email, role, or public, private, or unsafe metadata. The API uses `clerkClient.users.getUser(id)` for this lookup.

Use the environment file identified by the production Compose container metadata: `/opt/alavont/deploy/.env`. Have the operator edit it with `sudoedit`, add exactly one nonempty `MYORDER_OWNER_CLERK_ID=...` assignment, and retain mode `0600` and its existing restricted owner/group. Disable shell tracing and do not put the value in command arguments, terminal output, tickets, source control, or CI logs. Confirm only presence and permissions:

```bash
set +x
stat -c '%a %U:%G' /opt/alavont/deploy/.env
python3 - <<'PY'
from pathlib import Path
p = Path('/opt/alavont/deploy/.env')
rows = [line.partition('=')[2].strip() for line in p.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith('#')
        and line.partition('=')[0].strip() == 'MYORDER_OWNER_CLERK_ID']
assert len(rows) == 1 and rows[0], 'owner setting must occur exactly once and be nonempty'
print('owner setting present; value suppressed')
PY
sudo -u serveradmin python3 - <<'PY'
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

values = {}
for line in Path('/opt/alavont/deploy/.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"\'')
owner = values.get('MYORDER_OWNER_CLERK_ID', '')
secret = values.get('CLERK_SECRET_KEY', '')
assert owner and secret, 'owner subject and Clerk backend key must be configured'
request = Request('https://api.clerk.com/v1/users/' + quote(owner, safe=''),
                  headers={'Authorization': 'Bearer ' + secret})
with urlopen(request, timeout=15) as response:
    result = json.load(response)
assert result.get('id') == owner, 'Clerk returned a different user subject'
print('Clerk subject verified; value suppressed')
PY
```

Compose requires this variable and has no `_USER_ID` alias. Never output `docker compose config`, container environment, or the `.env` line to a terminal or log because those can contain secrets.

## Downtime expectation and prerequisites

There is no planned database restart or database downtime. The public API is already unavailable with HTTP 503 and must remain unavailable until the separately authorized hotfix API passes health and security verification. After that authorization, expect only the API cold-start interval before its health check passes; if any check fails, the outage continues under containment. Before starting, require: verified owner subject and mode-0600 env file, approved release SHA available in the protected source path, passing CI/security tests, a verified pre-patch database snapshot, exact 0067 ledger tip, and an API image whose label matches the approved SHA.

## Stage the exact source and image

The production checkout is mutable and currently resolves to the deployed parent SHA; the hotfix commit is not present there. First make this exact commit available through the approved, protected source/CI path. After that step is complete and deployment is separately authorized, run the following as the production deployment operator. This uses a detached release worktree and full-SHA image tag, not `/opt/alavont` source files:

```bash
set -euo pipefail
set +x
SHA=${APPROVED_RELEASE_SHA:?set the exact full SHA from the reviewed release record}
BASE=/opt/alavont
RELEASE=/opt/myorder-releases/myorder-p0-owner-approval-$SHA
ENV_FILE=/opt/alavont/deploy/.env

git -C "$BASE" fetch --no-tags origin security/p0-owner-approval-20261012
git -C "$BASE" cat-file -e "$SHA^{commit}"
git -C "$BASE" worktree add --detach "$RELEASE" "$SHA"
test "$(git -C "$RELEASE" rev-parse HEAD)" = "$SHA"
test -z "$(git -C "$RELEASE" status --porcelain)"

cd "$RELEASE/deploy"
export DEPLOY_SHA="$SHA"
dc() { docker compose --project-directory "$RELEASE/deploy" --env-file "$ENV_FILE" -f "$RELEASE/deploy/docker-compose.yml" -p deploy "$@"; }
dc config --services
dc build api
test "$(docker image inspect --format '{{index .Config.Labels "com.myorder.deploy-sha"}}' "myorder-api:$SHA")" = "$SHA"
```

The service list is `db`, `api`, `migrate`, `platform`, `nginx`; the release builds only `api`, does not build or run `migrate`, and `dc config --services` is not permission to start services. The image label check must return the full SHA. After API startup, also check the running container's image label and `/api/healthz` SHA.

## Preconditions and database patch

Keep `deploy-api-1` stopped until the explicit restart authorization. Verify Compose is targeting project `deploy`, its current database service is `deploy-db-1` on `deploy_postgres_data`, and nginx remains the existing service bound to `127.0.0.1:8081`. Take a verified database snapshot before applying SQL. Confirm the migration ledger is the production 0067 prefix; capture user and order counts. Apply the standalone SQL only after the approved snapshot is verified:

```bash
dc exec -T db sh -lc 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "/var/backups/myorder-pre-owner-hotfix-$SHA.dump"
pg_restore --list "/var/backups/myorder-pre-owner-hotfix-$SHA.dump" >/dev/null
dc exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from drizzle.__drizzle_migrations; select max(created_at) from drizzle.__drizzle_migrations"'
dc exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$RELEASE/deploy/hotfix-owner-approval.sql"
```

Do not run `dc run migrate`, `dc up migrate`, or the standard deployment workflow. Verify the two columns, index, one marker row, unchanged ledger tip, and unchanged user/order counts before starting the API. Keep all SQL output limited to schema/count/marker checks; do not query or print the owner value.

## Start and verify after separate authorization

Only after the operator has approved the restart, start just the API service. Do not start platform, nginx, or the migration service as part of this hotfix:

```bash
dc up -d --no-deps api
dc ps api db nginx
docker inspect deploy-api-1 --format '{{index .Config.Labels "com.myorder.deploy-sha"}}'
docker inspect deploy-api-1 --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "MYORDER_OWNER_CLERK_ID"}}owner_setting_present{{end}}{{end}}'
curl --fail --connect-timeout 5 --max-time 15 http://127.0.0.1:8081/api/healthz
curl --fail --connect-timeout 10 --max-time 20 https://myorder.fun/api/healthz
```

The image label and health JSON `sha` must equal the full release SHA. The API container health check probes `/healthz` on port 8080; nginx and platform health checks must remain healthy. Verify pending accounts and approved legacy accounts without matching owner provenance are denied on protected and shift routes; forged Clerk metadata does not grant access. Verify the configured owner can approve only with recent authentication, that approval records the owner subject and timestamp and chosen tenant, and that suspension clears provenance and denies access. Check the approval audit rows (`APPROVE_USER` / `UPDATE_USER_STATUS`) against owner actor and target IDs using a restricted audit session.

## Failure containment and rollback

If the SQL patch or any API, SHA, authorization, audit, or integrity check fails, stop the hotfix API and preserve the database and snapshot. Keep nginx/database/platform running and maintain the API outage. Do not restore the vulnerable API image, roll back the database, remove the additive columns, or modify accounts manually. Correct forward, rehearse against a disposable PostgreSQL 16 clone, then require a separately authorized release. There is no safe rollback to the known-vulnerable API.

After an authorized start, the containment command is:

```bash
dc stop api
dc ps api db nginx
curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w 'health_http=%{http_code}\n' https://myorder.fun/api/health
```

Require `deploy-api-1` stopped and HTTP 503 before leaving containment in place. Preserve the snapshot and live database for forward correction.
