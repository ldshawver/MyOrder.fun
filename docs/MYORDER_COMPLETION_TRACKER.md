# MyOrder.fun completion tracker

Last refreshed: 2026-11-23 UTC  
Authoritative baseline inspected: `origin/main` at `c6ddc67` after `git fetch --prune origin`  
Development branch: `codex/supervised-development`

## Verified increments

### Carrier adapter synthetic response contract (2026-11-23)

- Added a strict boundary for synthetic or sandbox Lucifer Direct carrier adapter responses before they can become durable checkout quote authority.
- Provider responses may supply only quote/service identity, fee, currency, expiry, and optional delivery estimate; the trusted server request context remains authoritative for the cart fingerprint and normalized destination snapshot.
- Rejected malformed or expanded payloads, negative/non-integer fees, invalid currency, unsafe configured provider identifiers, invalid destinations, expired quotes, and past delivery estimates.
- This increment validates the adapter response contract only. It does not call a carrier, persist a rate, bind checkout to a carrier quote, or claim credential-backed behavior.

Evidence:

- Focused Vitest: `carrierQuoteAdapter` — 1 file, 7 tests passed, covering accepted normalization and malformed, expanded, expired, and authority-crossing responses.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the adapter and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Durable Lucifer Direct carrier quote authority foundation (2026-11-23)

- Added forward-only migration `0086_carrier_quotes.sql` and matching Drizzle schema for opaque carrier rates created only by a future trusted server adapter.
- Persisted tenant/customer scope, provider identity, immutable service and destination snapshots, cart fingerprint, fee, currency, expiry, and single-consumption state outside browser authority.
- Constrained non-negative fees, three-letter lowercase currency, valid lifecycle state, provider-quote uniqueness within a tenant, and indexed active checkout lookup scope.
- This increment does not create or validate carrier rates and does not claim any provider behavior. Checkout binding and a reviewed carrier adapter/mock contract remain open.

Evidence:

- Focused Vitest: `carrier-quotes-schema-static` — 1 file, 1 test passed, covering server-owned snapshots, tenant/customer lookup scope, expiry, uniqueness, and single-use lifecycle.
- `pnpm run typecheck:libs` — passed.
- Focused ESLint on the regression test with zero warnings — passed.
- Migration ledger inventory/journal classification — passed: 92 SQL files, 61 executable entries, 31 historical/excluded. The validator then stopped at its optional database comparison because the configured database lacks the repository baseline tables; no migration application is claimed.
- `git diff --check` — passed.

### Checkout quote binding for server-created fulfillment groups (2026-11-23)

- Checkout quote creation now plans fulfillment groups from trusted normalized catalog fields before accepting tender, rejecting cash for any courier or shipping group rather than deferring that decision until order creation.
- The durable quote snapshot and customer response include each server-created group's provider, method, and trimmed pickup or customer-address destination. The client supplies no authoritative group key, provider, or method.
- Order creation recomputes the same group choices from current trusted lines and requires an exact snapshot match, so changed destinations, group membership, methods, or providers stale the quote before payment/order persistence.
- The storefront now includes its current shipping address in quote requests, while the server enforces address-required/address-forbidden policy for mixed, delivery, shipping, and pickup-only quotes.

Evidence:

- Focused Vitest: `checkoutFulfillmentGroups` and `fulfillment-groups-schema-static` — 2 files, 4 tests passed, covering mixed pickup/shipping destination snapshots and the durable quote/order binding source contract.
- `pnpm --filter @workspace/api-server typecheck` and `pnpm --filter @workspace/platform typecheck` — passed.
- Focused ESLint on the API group planner, order route, storefront checkout, and regression tests with zero warnings — passed.
- `git diff --check` — passed.

### Server-created mixed-cart group writes (2026-11-23)

- Checkout now partitions normalized lines from trusted server catalog fields: Alavont local inventory, Lucifer Direct local inventory, and CJ/Woo supplier inventory. The client cannot submit a provider, inventory owner, origin, group key, or authoritative method.
- CJ lines are forced into customer-free `standard_shipping`; the selected eligible local method applies only to Alavont/Lucifer Direct groups. Cash is rejected whenever any group is courier or shipping, while existing Alavont pickup cash remains eligible.
- Order creation atomically inserts immutable group origin, destination, quote, fee/tip, allocated merchandise, tax, total, currency, and status snapshots, then binds every new order item to its server-created group inside the existing inventory/quote/idempotency transaction.
- Mixed pickup plus CJ shipping now requires a customer shipping address while preserving the local pickup destination snapshot and existing Alavont pickup scheduling behavior.

Evidence:

- Focused Vitest: `checkoutFulfillmentGroups` and `fulfillment-groups-schema-static` — 2 files, 3 tests passed, covering trusted mixed-cart partitioning, CJ shipping enforcement, cash eligibility, transactional group writes, and line binding.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the group planner, regression tests, and order route with zero warnings — passed.
- `git diff --check` — passed.

### Immutable mixed-cart fulfillment group persistence foundation (2026-11-23)

- Added forward-only migration `0085_order_fulfillment_groups.sql` and matching Drizzle schema for tenant/order-bound server-created fulfillment groups.
- Persisted immutable provider, inventory-owner, origin, method, destination, provider quote, merchandise, fee, tax, total, currency, tax, and status snapshots at group scope.
- Bound each grouped order line to both its parent order and group with a composite foreign key, preventing a line from referencing a group belonging to another order. The new line reference remains nullable solely to preserve historical orders during rollout.
- Constrained supported authoritative provider/method values and non-negative group amounts, including database enforcement that group total equals merchandise plus fee plus tax.
- This increment establishes persistence only; checkout grouping and writes are not yet enabled and remain first in the queue.

Evidence:

- Focused Vitest: `fulfillment-groups-schema-static` — 1 file, 1 test passed, covering tenant/order isolation, line/group order binding, provider/method policy, and legacy-history preservation.
- `pnpm run typecheck:libs` — passed.
- Focused ESLint on the regression test with zero warnings — passed.
- `git diff --check` — passed.
- Migration ledger inventory/journal classification — passed: 91 SQL files, 60 executable entries, 31 historical/excluded. Optional database comparison then stopped because the configured database is not the documented disposable baseline and lacks `users`, `tenants`, `orders`, `lab_tech_shifts`, and `print_jobs`; no PostgreSQL migration validation is claimed and the command was not retried.

### Server-authoritative catalog amount writes (2026-11-23)

- Applied one catalog amount policy to both admin create and update writes: base, comparison, regular, and employee prices must be greater than zero when supplied, while cost basis may be zero but not negative.
- Preserved nullable optional amounts and existing Alavont catalog fields while preventing a client from persisting zero or negative selling prices through the update path.

Evidence:

- Focused Vitest: `catalogPricing` — 1 file, 7 tests passed, including create/update route enforcement and every governed amount boundary.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed catalog pricing implementation, route, and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PayPal bounded synthetic provider responses (2026-11-23)

- Bounded OAuth and authenticated PayPal JSON responses to 1 MiB, rejecting declared or streamed oversize bodies before provider data is trusted.
- Classified empty, malformed, array, and oversized provider payloads as invalid responses without exposing response bodies or credentials.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 21 tests passed, including declared-oversize and malformed-body rejection.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Uber dispatch tenant isolation and synthetic path contract (2026-11-23)

- Bound the dispatch-time customer contact lookup to both the order tenant and customer identity, preventing a same-ID user in another tenant from supplying courier contact data.
- Encoded the server-owned Uber customer identity in the delivery-creation path consistently with quote, lookup, and cancellation requests.
- This is synthetic mock-contract validation only. No Uber credential-backed dispatch or sandbox behavior is claimed.

Evidence:

- Focused Vitest: `uberDirect` — 1 file, 11 tests passed, including the tenant/customer lookup source contract and encoded synthetic provider customer path.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the changed Uber provider, fulfillment, and regression test files with zero warnings — passed.
- `git diff --check` — passed.

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

1. Secure group-specific checkout: storage, server-created mixed-cart grouping, quote-bound per-group choices/destinations, immutable transactional writes, line binding, and cash restrictions are implemented. Durable carrier quote authority and a reviewed synthetic adapter response contract now exist; next add the configured adapter invocation/persistence path and bind only eligible Lucifer Direct carrier groups to those records, then derive parent status from child groups and restrict staff/provider transitions by group ownership.
2. PostgreSQL validation for durable checkout quotes: `DATABASE_URL` resolves to the correctly named `myorder_agent_test`, but the refreshed target is an empty PostgreSQL 17 database without `users`, `tenants`, or `orders`, rather than the documented disposable migrated baseline. Migration 0084 therefore was not applied. Provision the repository baseline on this disposable database before adding tenant/customer cross-scope, expiry, rollback, and concurrent double-consumption integration coverage.
3. Provider sandbox/mock contracts: CJ/Woo outbound credential and synthetic write contracts are verified. Uber synthetic contracts now cover dispatch identity, tenant-scoped customer contact lookup, provider path encoding, idempotency key behavior, webhook HMAC isolation, bounded reconciliation, and cancellation; continue reviewed mock contracts for remaining payment and carrier behavior. Do not mark credential-dependent PayPal, CJ/Woo, or Uber validation complete without credentials.
4. Catalog reliability: continue tenant-scoped sellability, pricing, option, inventory, and archived-record regression coverage while preserving Alavont presentation behavior. Admin availability lifecycle diagnostics now distinguish unavailable rows from customer-visible rows.
5. Archived-catalog historical-reference rehoming: use the dry-run evidence to design and validate immutable history preservation before any deletion. Purge execution requires separate approval and remains outside supervised-development policy.

## External validation still open

- PayPal/Uber credential-backed sandbox verification.
- PayPal/CJ/Uber credential-backed sandbox verification remains external; synthetic contracts may continue without credentials.
