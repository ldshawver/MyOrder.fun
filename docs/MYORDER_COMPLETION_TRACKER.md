# MyOrder.fun completion tracker

Last refreshed: 2026-11-23 UTC  
Authoritative baseline inspected: `origin/main` at `c6ddc67` after `git fetch --prune origin`  
Development branch: `codex/supervised-development`

## Verified increments

### Durable tenant/customer-scoped checkout quotes (2026-11-23)

- Added forward-only migration `0084_durable_checkout_quotes.sql` and Drizzle schema for opaque, expiring checkout quote records.
- `/api/checkout/quote` persists the server-derived cart fingerprint, location, tax configuration, tax calculation, tender, fulfillment method, provider quote identity, and pickup selection. The existing `checkoutTaxQuoteToken` response field is preserved, but now carries an opaque database identity rather than client-portable financial authority.
- `/api/orders` requires the record to match the authenticated tenant and customer plus current server-recomputed catalog, tax, tender, fulfillment, delivery-quote, and pickup inputs.
- Order creation atomically changes the quote from `quoted` to `consumed` in the same transaction; concurrent or repeated non-idempotent consumption fails closed with `CHECKOUT_QUOTE_STALE`.
- Existing conversion snapshots and Alavont cart/order naming behavior were preserved.

Evidence:

- `pnpm run typecheck:libs` — pass.
- `pnpm --filter @workspace/api-server typecheck` — pass after referenced libraries were built.
- Focused Vitest: `durable-checkout-quotes-static`, `checkoutConversionGate`, and `order-endpoints-sse` — 3 files, 42 tests passed. This includes the Alavont-shaped SKU checkout regression.
- Focused ESLint on the changed order route and tests — pass with zero warnings.
- Migration ledger inventory/journal classification — pass: 90 SQL files, 59 executable entries, 31 historical/excluded. The command then correctly stopped before database comparison because `DATABASE_URL` is unset.
- PostgreSQL HTTP integration was not claimed: this checkout has no `DATABASE_URL`.

### Archived-catalog purge dry-run preparation (2026-11-23)

- Added a strictly read-only PostgreSQL report for archived catalog rows, with optional positive-integer tenant scope.
- Discovers catalog-reference columns from PostgreSQL metadata, safely quotes discovered identifiers, counts tenant-matched historical references, and blocks referenced rows from purge eligibility.
- Flags unprotected catalog-reference columns for historical-reference rehoming and manual schema-owner review.
- Added operator documentation that explicitly requires immutable snapshots, backup/restore rehearsal, rollback planning, and separate approval before any destructive purge.
- No deletion, update, production query, or destructive migration was executed.

Evidence:

- `pnpm --filter @workspace/scripts exec tsx --test src/catalog-archive-dry-run.test.ts` — 2 tests passed.
- `pnpm --filter @workspace/scripts typecheck` — passed.
- `git diff --check` — passed.
- Runtime PostgreSQL report execution remains open because the isolated checkout has no `DATABASE_URL`.

## Priority queue

1. Secure group-specific checkout: define the authoritative group/member model from product requirements, then bind conversion, quote, order, authorization, idempotency, and inventory decisions to that persisted scope. No group checkout schema or route contract exists on the refreshed baseline, so semantics must not be invented.
2. PostgreSQL validation for durable checkout quotes: apply migration 0084 to an isolated disposable database and add tenant/customer cross-scope, expiry, rollback, and concurrent double-consumption integration coverage.
3. Provider sandbox/mock contracts: add reviewed mock/sandbox contracts for payment and delivery behavior; do not mark credential-dependent PayPal or Uber validation complete without credentials.
4. Catalog reliability: continue tenant-scoped sellability, pricing, option, inventory, and archived-record regression coverage while preserving Alavont presentation behavior.
5. Expo ticket readability: increase the Expo ticket font size, verify the rendered layout, and add regression coverage.
6. Expo-only workflow printing: generate/print the Expo ticket for the affected workflow, not the separate work/prep ticket; preserve customer receipts, closeout documents, labels, and unrelated authorized document types.
7. Archived-catalog historical-reference rehoming: use the dry-run evidence to design and validate immutable history preservation before any deletion. Purge execution requires separate approval and remains outside supervised-development policy.

## External validation still open

- PayPal/Uber credential-backed sandbox verification.
- Isolated PostgreSQL runtime/concurrency verification for migration 0084 and checkout quote consumption.
- Product-authoritative definition of “group-specific checkout” if it means a scope distinct from the existing tenant/customer model.
