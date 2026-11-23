# MyOrder.fun completion tracker

Last refreshed: 2026-11-23 UTC  
Authoritative baseline inspected: `origin/main` at `c6ddc67` after `git fetch --prune origin`  
Development branch: `codex/supervised-development`

## Verified increments

### CJ/Woo provider mock contract and outbound credential boundary (2026-11-23)

- Routed the enabled WooCommerce order writer used for CJ Dropshipping synchronization through the existing DNS-checked, connect-time-pinned HTTPS transport. Unsafe origins, private/documentation addresses, redirects, oversized responses, and timeouts now fail closed before provider credentials can be forwarded.
- Extended the shared transport contract with bounded `GET`/`POST` request support while preserving the existing read-only integration callers.
- Removed untrusted provider response bodies from dispatch errors and now reject missing, non-integer, or non-positive provider order identities.
- This is synthetic mock-contract validation only. No CJ/Woo credential-backed dispatch or provider behavior is claimed.

Evidence:

- Focused Vitest: `wooSafeHttp` — 1 file, 37 tests passed, including a synthetic POST body contract and proof that the dispatch writer rejects a private origin before any global fetch call.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed transport, dispatch client, and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Catalog lifecycle availability diagnostics (2026-11-23)

- Corrected the server-owned admin lifecycle projection so an explicitly unavailable catalog item reports `unavailable_hidden` instead of the misleading `customer_visible` state.
- Preserved the more restrictive archived and compliance-hold precedence, customer eligibility filtering, sellability behavior, and Alavont presentation fields.

Evidence:

- Focused Vitest: `catalog-customer-visibility` — 1 file, 30 tests passed, including tenant isolation, restricted-row filtering, optional-schema failure diagnostics, inventory availability, and the corrected unavailable lifecycle state.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed catalog route and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Expo readability and affected-workflow-only printing (2026-11-23)

- Increased every operational Expo ticket text line to the thermal printer's double-height mode while retaining normal character width for item-name capacity; the order number remains double-width and double-height.
- Automatic order placement now queues the customer receipt (when authorized by the existing controls) and the affected order's Expo ticket only. It no longer creates the separate work/preparation ticket for that event.
- Preserved the explicit work-ticket document builder/catalogue for other authorized workflows, and did not change customer receipts, cash-closeout documents, labels, shift documents, or other document types.
- Preserved Alavont-only staff-ticket product identity and existing tenant, location, shift, routing, and idempotency behavior.

Evidence:

- Focused Vitest: `printDocuments` and `receipt-templates-routes` — 2 files, 35 tests passed. The render regression asserts all Expo operational text is `tall`/`large`, the encoded ESC/POS output contains double-height and double-size commands, both 50mm and 80mm layouts remain width-safe, and the automatic-order source contract includes Expo but excludes work/prep tickets.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed print implementation and tests with zero warnings — passed.
- `git diff --check` — passed.

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
3. Provider sandbox/mock contracts: CJ/Woo outbound credential and synthetic write contracts are now verified. Continue reviewed mock contracts for remaining payment, Uber, and carrier behavior; do not mark credential-dependent PayPal, CJ/Woo, or Uber validation complete without credentials.
4. Catalog reliability: continue tenant-scoped sellability, pricing, option, inventory, and archived-record regression coverage while preserving Alavont presentation behavior. Admin availability lifecycle diagnostics now distinguish unavailable rows from customer-visible rows.
5. Archived-catalog historical-reference rehoming: use the dry-run evidence to design and validate immutable history preservation before any deletion. Purge execution requires separate approval and remains outside supervised-development policy.

## External validation still open

- PayPal/Uber credential-backed sandbox verification.
- Isolated PostgreSQL runtime/concurrency verification for migration 0084 and checkout quote consumption.
- Product-authoritative definition of “group-specific checkout” if it means a scope distinct from the existing tenant/customer model.
