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
