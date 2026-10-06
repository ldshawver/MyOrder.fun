# MyOrder release-gate evidence — 2026-10-02

This is a sanitized evidence correction for the frozen candidate at
`7ddb22184c64f273dd610d51096c477ee8de61b8` (tree
`5ac4d527274591163b8fdd0f051e6619a13cb201`). Validation ran in a
separate detached worktree. No staging or production deployment occurred.

## Cash report correction

The earlier report line claiming merchandise `$108.00`, tax `$0.00`, order
total `$108.00`, and Cash settlement `$108.08` is unsupported by the available
database evidence. Read-only checks found zero `$108.08` cash ledger amounts
and zero `$108.08` order totals in production, staging, and dev. None had an
order with the reported `$108.00` merchandise / `$0.00` tax / `$108.00` total
combination. The only dev cash ledger entry at `$108.00` has merchandise
`$100.00`, tax `$8.00`, order total `$108.00`, and ledger `$108.00`; it is a
different, older order.

On a disposable migrated clone, the candidate API created and closed a new
`$108.00` merchandise / `$0.00` tax order. Its closeout API returned a
`$108.00` total and `$108.00` Cash due. Database reads after closeout showed
order subtotal/tax/total/remaining tender `108.00/0.00/108.00/108.00`, cash
ledger amount/tendered/change `108.00/108.00/0.00`, and payment status `paid`.
The original report has no order identifier or source artifact available in
this checkout, so its exact origin cannot be established. No historical paid
production order was changed.

## Tenant settings uniqueness

Production has one `admin_settings` row, zero duplicate `tenant_id` groups,
and no `admin_settings_tenant_id_unique_idx`. Staging and dev also have no
index and zero duplicate tenant groups. The historical
`0019_tenant_scoped_concierge_settings.sql` file is classified as unjournaled
in this candidate; its SHA-256 is absent from the 42-row production Drizzle
ledger. The rehearsed forward repair is
`lib/db/forward-repairs/20261002_admin_settings_tenant_uniqueness.sql`.
It is retained as evidence. Normal deployment uses the new journaled
`lib/db/drizzle/0073_admin_settings_tenant_uniqueness.sql` migration, appended
to `lib/db/drizzle/meta/_journal.json`. No existing migration or journal
record was changed. The migration checks for duplicate tenant rows and
verifies that the resulting index enforces full tenant uniqueness.

A production snapshot was restored into a disposable PostgreSQL container.
The repair succeeded twice there; a duplicate `tenant_id` insert was rejected
by the resulting valid unique index. With a duplicate present in a disposable
transaction, the repair stopped before index creation and rolled back.
Normalized data-only dump hashes of the original and repaired databases,
excluding nondeterministic dump markers and the sequence advanced by the
deliberate duplicate probe, matched:
`251a9c54fdb1f9f6bcf97d13c5c3d4a3d8c8b2cfda7bde0e12d6b8171f49af82`.
The repair left the 42-row ledger untouched. The separate test database then
applied the five pending candidate migrations and passed migration preflight
at 47/47. The journaled migration remains unapplied to staging and production.

## Uber Direct

Ambiguous creates remain nonretryable until provider reconciliation. A bounded
provider lookup can attach the authoritative delivery or enter
`manual_reconciliation_required`; a missing result never starts another
create. Expired paid quotes enter `requote_required` and leave payment `paid`
while marking fulfillment for review. Concurrent reconciliation and a stale
read during courier cancellation are covered by clone integration tests.

Using the existing encrypted staging sandbox credential record, a controlled
synthetic lifecycle completed authentication, quote, one create, provider
readback, and cancellation. No credentials or provider identifiers were
written to evidence. Sanitized lifecycle evidence is stored at
`/tmp/myorder-uber-sandbox-evidence.json`.

## Final checks and open gates

- API: 130 files passed, 10 skipped; 1,111 tests passed, 52 skipped.
- Platform: 19 files and 70 tests passed.
- Typecheck, ESLint, inventory lockdown, build, and migration preflight passed.
- ESLint reported one existing mockup warning. Build reported existing
  sourcemap and bundle-size warnings.
- The repository secret audit flagged an unchanged example `DATABASE_URL` in
  `docs/release-readiness.md:30`; no actual secret value was found in the
  changed code or regression logs. Uber provider error codes are now reduced
  to a safe token before logging.
- The first clone integration run failed on missing candidate columns before
  its five pending migrations were applied; the migrated clone passed all
  integration and full API tests. The root lint command hit a sandbox `tsx`
  IPC `EPERM` after ESLint passed; the same inventory check passed through
  `node --import tsx`.

## 2026-10-03 completion on `adi/myorder-release-gates-20261002`

The repository's normal `db:migrate` command applied nine pending journal
entries, including `0073`, to the disposable `myorder_tax_production_like`
clone restored from a local production snapshot. Migration preflight passed
at 48/48. PostgreSQL reports one valid unique tenant index and no duplicate
tenant groups. A transactional rehearsal dropped the index and inserted a
duplicate tenant row; `0073` stopped at its duplicate guard, and the
transaction rolled back with the valid index and 48-row ledger intact.

The guarded API integration suite passed all 11 tests on the migrated clone,
including the `$108.00` cash settlement, concurrent create reconciliation,
bounded provider lookup, provider identity mismatch, cancellation races, and
webhook updates during cancellation. API lint and repository typecheck passed.
The final API suite passed 129 files and 1,101 tests, with 11 files and 63
tests skipped by their normal opt-in gates. The guarded integration suite
passed separately with its opt-in flag and disposable clone marker. The
inventory write lockdown check passed.

**READY FOR CONTROLLED STAGING VALIDATION: YES.** No staging or production
deployment or push occurred. The historical `$108.08` report remains
unattributed; the current candidate reproduced a correct `$108.00` cash
settlement on the disposable clone.

## 2026-10-04 Lucifer staging acceptance and production restart incident

The Lucifer feature acceptance is preserved independently from deployment
safety. Staging ran SHA `48a5f3173a393de2d58db1390897592567fea218` (tree
`a9ae46a30489451932e32ec6a343f77c4b97b847`). The accepted Lucifer facts are:
the Woo origin is `https://shop.lucifercruz.com`; authenticated Woo connectivity
and the supported synchronization passed; 245 Woo products were imported and
the 186 existing local mapped records were preserved; guest catalog and
product detail passed with tenant/host isolation, public-field filtering and
protected APIs; landing, age gate, scanner, desktop/mobile, keyboard,
reduced-motion, console and CSP/font checks passed. No further Woo sync is
needed or authorized by the follow-up work package.

Deployment safety failed separately after a staging Compose command restarted
the production project. Read-only verification found the restored production
checkout at `/opt/alavont`, SHA `579cce225c0f9e7bee41a4c226d43e5ba5c86606`,
with production `deploy` images/configuration, healthy production API and
public proxy, production database `alavont`, and no staging configuration or
staging secrets in the running production containers. The production Drizzle
ledger remained at 42 rows, last timestamp 2026-09-28 12:53:20 UTC; no
migration command ran. The post-incident API and platform containers started
at 2026-10-04 06:35:19 UTC, with restart count zero after restoration. The
exact first restart timestamp was not recoverable from retained Docker event
data; proxy errors bound the incident to approximately 06:29–06:35 UTC.

Sanitized proxy aggregates show 287 requests in the 06:25–06:36 UTC interval,
including approximately 160 API 401 responses during 06:30–06:35, 503/502
responses during recovery, and one catalog 500 from the acceptance probe.
Public page/assets and health requests returned successfully after recovery.
This confirms client traffic during the restart window; the logs do not
identify unique customers. The command issued was limited to `compose up -d
--no-deps api platform`, followed by health and public-catalog GET probes; no
migrations or write endpoints were invoked. No production database writes
were attributable to those explicit commands.

A read-only refresh on 2026-10-06 found all four `deploy` containers healthy;
the API and platform images still use SHA
`579cce225c0f9e7bee41a4c226d43e5ba5c86606`, the API restart count remains
zero, and the public health endpoint reports that SHA. The API runtime remains
`NODE_ENV=production`, targets host `db` / database `alavont`, has no
`STAGING_*` variables, and is attached only to `deploy_internal`. The migration
ledger remains at 42 rows, max timestamp `1790600000002`. A Compose `ps`
read-only attempt could not interpolate the required `DEPLOY_SHA` from the
operator shell; direct Docker metadata, database query, and health checks
provided the verified results above. No production write was performed.

Status remains deliberately split:

- **LUCIFER FUNCTIONAL STAGING ACCEPTANCE: PASS**
- **DEPLOYMENT SAFETY ACCEPTANCE: FAIL — accidental production restart**
- **OVERALL RELEASE ACCEPTANCE: FAIL** until the deployment guard and
  remaining MyOrder/provider gates are complete.

## PayPal staging evidence checked 2026-10-06

The staging database has four PayPal sandbox attempts in `captured`, six in
`created`, one in `failed`, and one recorded `CHECKOUT.ORDER.APPROVED` event
in `verified`. A sanitized scan of the retained 30-day staging API logs found
no `PayPal webhook rejected` classifications. Since the route persists an
event only after successful signature verification, the event ledger cannot
show failures that occur earlier (for example, missing headers, unknown local
provider identity, or failed PayPal signature verification). The historical
HTTP 400s therefore cannot be attributed to a specific stage from retained
staging evidence. The event handler continues to require PayPal signature
verification; unknown or unmapped events are not acknowledged as trusted.

The SDK v6 browser tests prove the server-created order is handed to the
provider session and capture is called only from `onApprove`. Provider and
payment-service tests cover signed webhook retries, captured-order
idempotency, reservation lifecycle, and safe recovery. A full live PayPal
sandbox browser approval/capture/webhook acceptance has not been established
by this run, and the six `created` staging attempts were left untouched.

## Staging tenant consolidation inventory checked 2026-10-06

Read-only staging counts identify tenant `1` (`house`, active) as the canonical
staging tenant: 10 users, 28 orders and 431 catalog rows. Two active test
tenants remain: tenant `2` (`release-gates-musi9vkl`, 3 users, 13 orders, 3
catalog rows) and tenant `3` (`release-gates-other-musi9vkl`, 1 user, no orders
or catalog rows). Historical rows were not rewritten. Tenant disable/archive
is deferred until the pending PayPal provider acceptance is complete; tenant
2's historical orders must remain attached to their original tenant.
