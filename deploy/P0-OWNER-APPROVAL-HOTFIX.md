# P0 owner approval hotfix release procedure

> **Superseded historical procedure.** This file describes the earlier
> production 0067-only hotfix release and must not be used for the current
> release. The current lineage, owner configuration, P0 patch scope, and
> separate staging/production plans are in
> [RELEASE-CONVERGENCE.md](./RELEASE-CONVERGENCE.md). Production already has
> the P0 marker/provenance schema and requires forward migrations 0068–0076;
> staging has 0075/0076 but still requires the separately approved P0 patch.
> No command below authorizes or directs a current staging or production
> operation.

## Release identity and migration scope

The current production API revision reported for this recovery is `364bcc72e1da9109a7b2933e818f17af8a8162c3`. The current production platform revision reported for this recovery is `579cce225c0f9e7bee41a4c226d43e5ba5c86606`. These are the deployed versions to record during preflight; neither should be treated as the target. The target API and platform revision is the exact full SHA of the final reviewed PR #147 head after this runbook and code have passed CI. Record that SHA in the release manifest and require both replacement images to carry it in their revision labels.

The previously built API candidate image `sha256:6523ae58917a025927734b74a277aa0312cb66a121e218636dd447ffc7aaccd8` was built from `6061c505f3553b6c9b0cd51c784f61804d56ec17`; it is not the final release image if the reviewed PR head changes. The final API image and the proposed platform image must both be rebuilt from the final reviewed PR SHA and carry that exact revision in both `org.opencontainers.image.revision` and `com.myorder.deploy-sha` labels. The platform image contains the frontend's explicit account-approval error handling; the API image contains the backend owner authorization correction.

Production's Drizzle ledger ends at the 0067 prefix. `deploy/hotfix-owner-approval.sql` is the only database change for this release. It is a standalone transaction, writes marker `public.myorder_hotfix_migrations / p0_owner_approval_provenance`, and leaves the Drizzle ledger unchanged. The committed `0068_print_jobs_document_job_types` migration remains deferred. Do not build or run the `migrate` Compose service, invoke `drizzle-kit migrate`, or use the normal deploy workflow for this hotfix. A future release must restore the pending print migration and add an idempotent Drizzle reconciliation migration for the owner provenance columns after it.

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

There is no planned database restart or database downtime. The currently reported API revision is `364bcc72e1da9109a7b2933e818f17af8a8162c3`; the currently reported platform revision is `579cce225c0f9e7bee41a4c226d43e5ba5c86606`. The API was previously reported healthy, while owner inventory and approval flows remain unresolved. Until a separate production authorization is given, leave API and platform untouched. After authorization, expect an API cold-start interval while Compose replaces the API, followed by a separate platform replacement interval if that image is authorized. If any check fails, stop the candidate API and keep the database and backup intact; never restore the known-vulnerable API. Before starting, require verified owner configuration, approved release SHA available in the protected source path, passing CI/security tests, verified database snapshot and Stage 1 patch status, exact 0067 ledger tip, and API/platform images whose labels match the approved SHA.

## Stage the exact source and image

After PR #147 has the final reviewed SHA and all required CI checks pass, make that exact commit available through the approved, protected source/CI path. After deployment is separately authorized, run the following as the production deployment operator. This uses a detached release worktree and full-SHA image tags, not mutable `/opt/alavont` source files:

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
dc build --pull=false api platform
for service in api platform; do
  image="myorder-$service:$SHA"
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$SHA"
  test "$(docker image inspect --format '{{index .Config.Labels "com.myorder.deploy-sha"}}' "$image")" = "$SHA"
  docker image inspect --format '{{.Id}} {{index .Config.Labels "com.myorder.deploy-sha"}}' "$image"
done
```

The service list is `db`, `api`, `migrate`, `platform`, `nginx`; the release builds only the `api` and `platform` images, and does not build or run `migrate`. `dc config --services` does not start services. Before startup, verify that the effective Compose configuration selects exactly `myorder-api:$SHA` and `myorder-platform:$SHA`, that `MYORDER_OWNER_CLERK_ID` is explicitly passed to the API, and that the platform build uses the protected production `.env` values for the Clerk publishable key and `https://myorder.fun/api/__clerk` proxy. Do not print rendered Compose configuration. Record each image ID and digest with its matching labels. After startup, check the running container's image label and `/api/healthz` SHA.

## Preconditions and database patch

Do not change `deploy-api-1` or any other production service until explicit deployment authorization. Verify Compose is targeting project `deploy`, its current database service is `deploy-db-1` on `deploy_postgres_data`, and nginx remains the existing service bound to `127.0.0.1:8081`. Take and verify a protected database snapshot before any production SQL action. Confirm the migration ledger is the production 0067 prefix; capture user and order counts. Apply the standalone SQL only after the approved snapshot is verified and SQL application is separately authorized:

```bash
dc exec -T db sh -lc 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "/var/backups/myorder-pre-owner-hotfix-$SHA.dump"
pg_restore --list "/var/backups/myorder-pre-owner-hotfix-$SHA.dump" >/dev/null
dc exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from drizzle.__drizzle_migrations; select max(created_at) from drizzle.__drizzle_migrations"'
dc exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$RELEASE/deploy/hotfix-owner-approval.sql"
```

Do not run `dc run migrate`, `dc up migrate`, or the standard deployment workflow. Verify the two columns, index, one marker row, unchanged ledger tip, and unchanged user/order counts before starting the API. Keep all SQL output limited to schema/count/marker checks; do not query or print the owner value.

## Start and verify after separate authorization

Only after the operator has approved the restart, start the verified API and platform images. Do not run the migration service, recreate PostgreSQL, or restart nginx. First update the API with dependencies disabled, verify its owner configuration, health and security smoke tests; then update only the platform after confirming Clerk initialization and proxy routing. Keep the existing database, nginx and platform instances in service until their individual replacement is explicitly authorized. The API-only command is:

```bash
dc up -d --no-deps --no-build --pull never api
dc ps api db nginx
docker inspect deploy-api-1 --format '{{index .Config.Labels "com.myorder.deploy-sha"}}'
docker inspect deploy-api-1 --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "MYORDER_OWNER_CLERK_ID"}}owner_setting_present{{end}}{{end}}'
curl --fail --connect-timeout 5 --max-time 15 http://127.0.0.1:8081/api/healthz
curl --fail --connect-timeout 10 --max-time 20 https://myorder.fun/api/healthz
```

After the API passes its checks, a separately authorized frontend replacement uses `dc up -d --no-deps --no-build --pull never platform`; do not include `nginx`, `db`, or `migrate` in either command. Confirm the Clerk proxy remains routed through `/api/__clerk` and that the platform health check passes.

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
