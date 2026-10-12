# P0 owner approval hotfix

## Scope

This release is based on production API commit `579cce225c0f9e7bee41a4c226d43e5ba5c86606`. The production migration ledger ends at 0067. Migration 0068 in this release is the additive owner approval provenance migration. The unrelated print job migration that occupied the unapplied 0068 slot in the source candidate is deferred; restore it as a later migration after this hotfix.

The standalone, idempotent P0 SQL patch adds nullable `users.approved_by_clerk_id` and `users.approved_at` columns plus a partial index. It records its completion in `public.myorder_hotfix_migrations`; it leaves the Drizzle ledger at 0067. Existing approved accounts have no provenance and therefore fail closed until the configured owner explicitly approves them.

## Secure owner configuration

Supply `MYORDER_OWNER_CLERK_ID` through the production secret/configuration mechanism. Use the verified Clerk subject ID for the designated owner. Do not put it in source control, public metadata, request bodies, or client configuration. The API fails closed when it is unset.

## Deployment commands (run only after explicit release authorization)

Keep the API stopped while preparing the release. Set the SHA and load the existing production Compose environment without printing secret values. Confirm the secure owner subject ID is available to Compose, and take and verify a database snapshot:

```bash
export DEPLOY_SHA=<approved-hotfix-commit-sha>
docker compose build api
docker compose exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < deploy/hotfix-owner-approval.sql
docker compose up -d --no-deps api
docker compose ps api
docker compose logs --tail=100 api
curl --fail https://myorder.fun/api/health
```

Before those commands, confirm that the migration validator reports the 0067 prefix, and confirm the secure owner ID is configured. Do not run the general `migrate` service: it would apply the unrelated 0068 print job migration. The SQL patch is idempotent and should be verified by checking both columns, the index, the hotfix marker row, and that the Drizzle ledger still ends at 0067.

## Verification

1. Confirm `deploy-api-1` reports the approved SHA and `MYORDER_OWNER_CLERK_ID` is present without printing its value.
2. Confirm both columns and the index exist, `myorder_hotfix_migrations` contains `p0_owner_approval_provenance`, and the Drizzle ledger still ends at 0067.
3. Confirm `/api/health` is HTTP 200.
4. Confirm pending and legacy accounts are denied on protected and shift routes, even with forged Clerk public/unsafe metadata.
5. Confirm only the configured owner with recent authentication can approve, provenance records the owner subject and timestamp, tenant assignment is correct, and a suspended account is denied.
6. Confirm auth, shift, application health, and database integrity checks pass before ending maintenance.

## Failure containment

If SQL or API verification fails, stop the hotfix API and keep the API unavailable behind the existing 503 response. Preserve the database and snapshot. Do not drop the additive columns, restore the vulnerable API image, or alter accounts manually through this release. Correct the release forward, rehearse it on a disposable clone, then seek authorization before restarting production. Later, reconcile this standalone schema patch into the Drizzle lineage before any subsequent general migration run.
