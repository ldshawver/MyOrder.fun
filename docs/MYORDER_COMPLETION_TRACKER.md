# MyOrder.fun completion tracker

Last refreshed: 2026-11-23 UTC  
Authoritative baseline inspected: `origin/main` at `c6ddc67` after `git fetch --prune origin`  
Development branch: `codex/supervised-development`

## Verified increments

### PayPal capture order identity binding (2026-11-23)

- Bound the represented capture response to the exact provider order requested by the server before returning a capture for local persistence.
- A syntactically valid capture response for a different PayPal order now fails closed as an invalid provider response; existing server-owned capture idempotency and durable reconciliation behavior remain unchanged.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox or live behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 33 tests passed, including mismatched capture-order identity.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the PayPal provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PayPal create-order authority binding (2026-11-23)

- Bound the represented PayPal purchase unit to the exact server-authored internal order reference, amount, and currency before returning a provider order for local persistence.
- A syntactically valid create response that substitutes a different order reference or financial value now fails closed as an invalid provider response; existing server-owned request construction, idempotency identity, and approval-origin validation remain unchanged.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox or live behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 32 tests passed, including mismatched internal reference, amount, and currency representations.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the PayPal provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PayPal read identity binding (2026-11-23)

- Bound order and capture lookup responses to the exact provider resource identity requested by the server. A syntactically valid response for a different PayPal order or capture now fails closed before reconciliation can attach it to local payment state.
- Existing server-owned lookup paths, response bounds, credential handling, and mutation idempotency behavior remain unchanged.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox or live behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 29 tests passed, including mismatched order and capture lookup identities.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the PayPal provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PayPal ambiguous mutation outcome classification (2026-11-23)

- PayPal OAuth is now acquired before the payment request transport boundary, so authentication transport failures remain retryable provider errors and cannot be mistaken for an attempted payment mutation.
- Once idempotent create, capture, or refund work is handed to the transport, any connection rejection or timeout is classified as an unknown outcome. Callers must retain durable reconciliation state and use the existing PayPal idempotency identity rather than treating the mutation as definitely absent.
- Read-only provider lookup transport failures remain ordinary provider errors because they cannot create a remote financial side effect.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox or live behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 28 tests passed, including ambiguous mutating transport failure, pre-mutation OAuth failure, read-only lookup failure, idempotency headers, response bounds, and approval-origin validation.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the PayPal provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PayPal approval redirect origin boundary (2026-11-23)

- Validated provider-supplied approval links before returning them to the browser. Sandbox orders may redirect only to the exact HTTPS `www.sandbox.paypal.com` origin, while live orders may redirect only to the exact HTTPS `www.paypal.com` origin.
- Rejected malformed URLs, cleartext URLs, lookalike subdomains, and unrelated hosts as invalid provider responses; server-owned API origins, amounts, and existing payment idempotency behavior remain unchanged.
- This is synthetic mock-contract validation only. No PayPal credential-backed sandbox or live behavior is claimed.

Evidence:

- Focused Vitest: `paypal` provider — 1 file, 26 tests passed, including configured sandbox/live approval origins and rejection of malicious redirect variants.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the PayPal provider and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Bounded carrier adapter invocation (2026-11-23)

- Added a 15-second deadline around the reviewed server-side carrier quote adapter and passed an abort signal into the adapter contract so stalled provider work can be cancelled.
- A timed-out provider call fails closed with `CARRIER_PROVIDER_TIMEOUT` before quote validation or durable persistence; tenant, customer, cart, destination, pricing, and quote authority remain server-owned.
- This is synthetic mock-contract validation only. No production carrier selection or credential-backed carrier behavior is claimed.

Evidence:

- Focused Vitest: `carrierQuoteAdapter` — 1 file, 11 tests passed, including abort signaling, deterministic timeout classification, and proof that a stalled provider cannot persist a quote.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the carrier adapter and regression test with zero warnings — passed.
- `git diff --check` — passed.

### PostgreSQL CJ event reconciliation isolation and idempotency (2026-11-23)

- Added a disposable-database integration regression for durable CJ fulfillment events and verified the configured target is PostgreSQL 17.
- Verified the database rejects an event bound to another tenant's fulfillment, transaction rollback removes the event and restores fulfillment/group/parent state, and a row lock blocks a competing fulfillment writer.
- Verified two concurrent claims of one provider event identity produce exactly one durable event, then verified reconciliation-required provider, group, derived-parent, and processed-event state persists atomically.
- The disposable target initially lacked the latest CJ tables, so forward-only `0087_cj_fulfillment_events.sql` was applied transactionally before the passing test. This validates that migration SQL and the provisioned runtime schema only; it does not claim a historical migration ledger, production migration, or credential-backed provider behavior.

Evidence:

- `pnpm --filter @workspace/db exec tsx --test scripts/cj-fulfillment-events-postgres.test.ts` — 1 PostgreSQL integration test passed against PostgreSQL 17.
- `pnpm --filter @workspace/db exec tsc --noEmit` — passed.
- `git diff --check` — passed.
- Focused ESLint is unavailable for the standalone DB package because it has no ESLint dependency/configuration; the package TypeScript gate covers the added test.

### PostgreSQL mixed-order group atomicity and isolation (2026-11-23)

- Added a disposable-database integration regression for server-created mixed-order persistence and verified the configured target is PostgreSQL 17.
- Verified the database rejects a fulfillment group whose tenant differs from its parent order and rejects a line bound to a fulfillment group from a different parent order.
- Verified transaction rollback removes the parent order, group, and line together, while a committed mixed pickup/CJ shipping order retains two immutable groups with every line bound to its own group.
- The test creates uniquely named tenant/customer/catalog/order fixtures and removes them in cleanup. This validates the provisioned `push-force` runtime schema only; it does not claim a historical migration ledger or production migration evidence.

Evidence:

- `pnpm --filter @workspace/db exec tsx --test scripts/fulfillment-groups-postgres.test.ts` — 1 PostgreSQL integration test passed against PostgreSQL 17.
- `pnpm --filter @workspace/db exec tsc --noEmit` — passed.
- `git diff --check` — passed.
- Focused ESLint is unavailable for the standalone DB package because it has no ESLint dependency/configuration; the package TypeScript gate covers the added test.

### PostgreSQL durable checkout quote isolation and concurrency (2026-11-23)

- Added a disposable-database integration regression for the durable checkout quote authority boundary and verified the configured target is PostgreSQL 17.
- Verified tenant and customer cross-scope lookups fail closed, expired quotes cannot be selected, and a rolled-back consumption leaves the quote available.
- Verified row locks block a competing writer and that two concurrent conditional consumers produce exactly one success. A later replay cannot consume the quote again.
- The test creates uniquely named tenant/customer/quote fixtures and removes them in cleanup. This validates the provisioned `push-force` runtime schema only; it does not claim a historical migration ledger or production migration evidence.

Evidence:

- `pnpm --filter @workspace/db exec tsx --test scripts/checkout-quotes-postgres.test.ts` — 1 PostgreSQL integration test passed against PostgreSQL 17.
- `pnpm --filter @workspace/db exec tsc --noEmit` — passed.
- `git diff --check` — passed.
- Focused ESLint was unavailable for the standalone DB package because it has no ESLint dependency/configuration; the package TypeScript gate covers the added test.

### Bounded tenant-scoped CJ polling reconciliation (2026-11-23)

- Added a bounded server-only reconciliation service for pending or reconciliation-required CJ fulfillment identities. It selects at most 25 records from one trusted tenant scope and exposes no staff-authored status transition path.
- Provider polling loads only that tenant's encrypted Woo credentials and uses the existing DNS-checked, connect-time-pinned, timeout- and response-bounded transport.
- Strictly validates the provider order identity, supported status, and provider modification time, rejects identity mismatch, and routes every accepted snapshot through the same replay-safe event inbox, forward-only transition policy, CJ-only group mutation, and derived-parent transaction used by authenticated webhooks.
- Stable polling event identities make unchanged provider snapshots replay-safe, while `last_reconciled_at` records successful authoritative checks. Per-order provider failures remain isolated for a later bounded retry.
- This is synthetic contract validation only. No credential-backed CJ/Woo polling behavior is claimed.

Evidence:

- Focused Vitest: `cjFulfillmentReconciliation`, `cjFulfillmentEventProcessor`, and `cjFulfillmentEvents` — 3 files, 8 tests passed, covering strict snapshot parsing, Woo hold normalization, tenant/batch bounds, encrypted credential selection, pinned transport use, provider identity binding, durable event routing, and no staff impersonation path.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on reconciliation, event processing, and regression tests with zero warnings — passed.
- `git diff --check` — passed.

### Authenticated replay-safe CJ/Woo fulfillment events (2026-11-23)

- Extended the existing tenant-specific Woo HMAC boundary to accept signed `order.updated` events for mapped CJ fulfillment identities. Tenant scope comes only from the uniquely matched encrypted server configuration; event payloads cannot supply tenant, group, or parent-order authority.
- Added one transaction that locks the tenant/provider fulfillment identity, claims the payload-hashed event inbox, rejects event-ID payload mismatches, applies the forward-only CJ transition policy, updates only a CJ-owned group, derives the parent from every child group, and marks the event processed.
- Exact authenticated replays are idempotently acknowledged. Stale, regressive, conflicting terminal, hold, and failure states move the durable fulfillment/group/parent path to reconciliation rather than fabricating progress.
- Unmapped provider identities fail for retry and are never attached by payload data. Provider polling reconciliation and credential-backed CJ/Woo sandbox validation remain open; this is synthetic contract validation only.

Evidence:

- Focused Vitest: `cjFulfillmentEvents` and `cjFulfillmentEventProcessor` — 2 files, 6 tests passed, covering strict event authority, forward-only decisions, tenant signature routing, row locking, payload-hash replay checks, CJ-only group mutation, parent derivation, and atomic processed state.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the processor, signed webhook route, and regression test with zero warnings — passed.
- `git diff --check` — passed.

### CJ provider event transition policy (2026-11-23)

- Added a strict, bounded CJ event payload contract that accepts only provider event identity, type, order identity, status, and an optional offset-aware provider timestamp. Tenant and fulfillment authority cannot be supplied in the event payload.
- Mapped CJ states to the canonical fulfillment-group lifecycle. Provider hold/failure states escalate to reconciliation rather than fabricating successful fulfillment progress.
- Added forward-only event decisions: repeated status is idempotent, completed-to-refunded is allowed, and stale, regressive, or conflicting terminal events require reconciliation.
- This is synthetic policy validation only. Authenticated webhook ingestion, durable inbox claiming/payload-hash replay handling, transactional group/parent updates, and polling reconciliation remain open; no credential-backed CJ behavior is claimed.

Evidence:

- Focused Vitest: `cjFulfillmentEvents` — 1 file, 4 tests passed, covering strict payload authority, status mapping, forward/refund progress, idempotency, stale events, regressions, and terminal conflicts.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the policy and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Durable CJ provider fulfillment event foundation (2026-11-23)

- Added forward-only migration `0087_cj_fulfillment_events.sql` and matching Drizzle schema for tenant/order/group-bound CJ provider order identities.
- Added a tenant-scoped, payload-hashed provider-event inbox with a unique provider event identity, immutable receipt timestamps, and explicit processing state needed for replay-safe event handling.
- Persisted bounded CJ provider and reconciliation states plus indexed reconciliation work. Composite foreign keys prevent an event or provider order from crossing tenant, parent-order, or server-created fulfillment-group boundaries.
- This increment establishes persistence only. Authenticated webhook ingestion, state transition policy, parent-status derivation, and provider polling reconciliation remain open; no credential-backed CJ behavior is claimed.

Evidence:

- Focused Vitest: `cj-fulfillment-schema-static` — 1 file, 1 test passed, covering tenant/order/group isolation, provider-order uniqueness, event idempotency, payload binding, and reconciliation state persistence.
- `pnpm run typecheck:libs` — passed.
- Focused ESLint on the regression test with zero warnings — passed.
- `git diff --check` — passed.

### Staff fulfillment-group authority and derived parent lifecycle (2026-11-23)

- Added a tenant/order/group-scoped staff transition path for server-created fulfillment groups. It row-locks the target group, applies the canonical lifecycle graph, derives the parent lifecycle from every child group, and persists the group and parent changes atomically.
- Staff may transition only Alavont and Lucifer Direct groups. CJ remains provider-managed, and the staff path fails closed rather than impersonating a CJ provider event.
- CSR transitions retain assigned active ready-shift authorization. Group completion retains payment-close and Uber-delivery completion gates; paid group cancellation remains restricted to the supported refund workflow.
- Group changes write a dedicated actor audit record and publish the derived parent update. Legacy parent fulfillment endpoints now reject grouped orders so child state cannot be bypassed.
- Provider-authenticated CJ event ingestion, event idempotency, and reconciliation remain open; this increment does not claim provider event behavior.

Evidence:

- Focused Vitest: `fulfillmentGroupLifecycle` — 1 file, 11 tests passed, covering provider ownership, legal transitions, mixed child-state parent derivation, tenant-scoped locking, audit, and legacy parent-mutation rejection source contracts.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the lifecycle policy, route, and regression test with zero warnings — passed.
- `git diff --check` — passed.

### Atomic Lucifer Direct carrier quote checkout binding (2026-11-23)

- Checkout quote creation now accepts an opaque carrier quote only for the server-derived Lucifer Direct group and revalidates tenant, customer, active lifecycle, expiry, trusted group cart fingerprint, and normalized destination address before including its fee in server totals.
- Carrier selection changes only the Lucifer Direct group; Alavont retains its existing pickup behavior and CJ remains customer-free standard shipping. Cash remains unavailable whenever the resulting cart contains carrier or shipping fulfillment.
- Order creation repeats the authority checks, requires the durable checkout snapshot to bind the same carrier quote and group plan, and atomically consumes the carrier quote beside the checkout quote, inventory/order work, and group persistence. A concurrent or replayed non-idempotent consumption cannot dispatch the same quote twice.
- The immutable carrier group stores the trusted full destination, durable quote identity, provider/service/fee/currency/expiry snapshot, and server-derived group amounts. No production carrier or credential-backed validation is claimed.

Evidence:

- Focused Vitest: `checkoutFulfillmentGroups` and `carrier-quotes-schema-static` — 2 files, 8 tests passed, covering carrier assignment only to Lucifer Direct, trusted mixed-cart grouping, cash policy, scoped quote validation, transactional consumption, and immutable group quote/destination persistence contracts.
- `pnpm run typecheck:libs` and `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the group planner, order route, and regressions with zero warnings — passed.
- `git diff --check` — passed.

### Authenticated Lucifer Direct carrier quote path (2026-11-23)

- Added a customer-checkout-authenticated carrier quote endpoint that re-normalizes the tenant catalog cart and selects only the server-derived Lucifer Direct group before invoking the carrier service.
- Tenant and customer scope come from authenticated server context; provider, group membership, current prices, cart fingerprint, and durable quote identity cannot be supplied by the client.
- The endpoint fails closed with `503 CARRIER_PROVIDER_UNAVAILABLE` until a reviewed process-level adapter is configured, and it returns only the existing bounded durable quote response.
- This increment does not select a production carrier, bind or consume a carrier quote during checkout, or claim credential-backed provider behavior.

Evidence:

- Focused Vitest: `carrierQuoteAdapter`, `checkoutFulfillmentGroups`, and `carrier-quotes-schema-static` — 3 files, 16 tests passed, covering fail-closed adapter configuration, trusted Lucifer Direct line selection, authenticated route registration, server scope, and no client provider authority.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the carrier service, grouping implementation, order route, and regressions with zero warnings — passed.
- `git diff --check` — passed.

### Trusted carrier adapter invocation and persistence boundary (2026-11-23)

- Added a server-only creation service that invokes a configured carrier adapter with the trusted cart fingerprint and destination, validates the response through the existing strict contract, and persists the resulting rate with authenticated tenant/customer scope.
- The adapter cannot author tenant, customer, cart, or destination authority. Invalid scope and malformed, expired, or otherwise rejected adapter responses fail before any durable write.
- The customer-facing result contains an opaque durable quote ID and the validated service, fee, currency, and expiry only.
- This increment does not expose a checkout route, select a production carrier, bind or consume a carrier quote, or claim credential-backed provider behavior.

Evidence:

- Focused Vitest: `carrierQuoteAdapter` — 1 file, 9 tests passed, including configured adapter invocation, trusted persistence, opaque identity, invalid scope, and no-write rejection behavior.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- Focused ESLint on the adapter and regression test with zero warnings — passed.
- `git diff --check` — passed.

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

1. Secure group-specific checkout: storage, server-created mixed-cart grouping, quote-bound per-group choices/destinations, immutable transactional writes, line binding, cash restrictions, authenticated fail-closed Lucifer Direct carrier quote creation/binding/atomic consumption, derived parent lifecycle, staff transition ownership, authenticated replay-safe CJ/Woo event application, and bounded tenant-scoped provider polling reconciliation without staff impersonation are implemented. Durable quote PostgreSQL isolation, expiry, rollback, locking, idempotency, and concurrent consumption are verified. Mixed-order PostgreSQL atomic rollback, tenant/order group isolation, line binding, and committed group persistence are verified. CJ event PostgreSQL tenant isolation, rollback, locking, concurrent replay claiming, and atomic reconciliation persistence are verified; continue remaining provider mock contracts before the release gate.
2. Provider sandbox/mock contracts: CJ/Woo outbound credential and synthetic write contracts are verified. Uber synthetic contracts now cover dispatch identity, tenant-scoped customer contact lookup, provider path encoding, idempotency key behavior, webhook HMAC isolation, bounded reconciliation, and cancellation. Carrier quote responses, trusted persistence, fail-closed configuration, and bounded abortable invocation are verified synthetically. PayPal response bounds, configured-environment approval redirect origins, ambiguous mutation outcome classification, read identity binding, and create-order internal-reference/financial binding are verified synthetically; continue reviewed mock contracts for remaining payment behavior. Do not mark credential-dependent PayPal, CJ/Woo, Uber, or carrier validation complete without credentials.
3. Catalog reliability: continue tenant-scoped sellability, pricing, option, inventory, and archived-record regression coverage while preserving Alavont presentation behavior. Admin availability lifecycle diagnostics now distinguish unavailable rows from customer-visible rows.
4. Archived-catalog historical-reference rehoming: use the dry-run evidence to design and validate immutable history preservation before any deletion. Purge execution requires separate approval and remains outside supervised-development policy.

## External validation still open

- PayPal/Uber credential-backed sandbox verification.
- PayPal/CJ/Uber credential-backed sandbox verification remains external; synthetic contracts may continue without credentials.
