# CSR delivery and shift-closeout accounting

## Product classification before activation

The migration deliberately leaves every existing product as `unclassified`. An operator must review each tenant's products and set `commissionEligibility` to exactly one of:

- `eligible` — discounted product sales earn the supervisor-selected commission.
- `membership` — memberships never earn commission.
- `excluded` — another explicitly non-commissionable product.
- `unclassified` — fail-closed default; no commission is earned.

No production mapping is changed by this PR. The tenant-scoped admin catalogue response exposes this field, and the existing admin catalogue update route accepts it. Operators should export or filter the admin catalogue for `commissionEligibility=unclassified`, classify every active product, and retain the approval record. An order snapshots the classification plus gross and allocated discount amounts, so later catalogue edits cannot change an earlier closeout.

## Accounting boundaries

- CSR and Uber Direct delivery both require the same unexpired, tenant/customer/cart/address-bound server quote. The saved quote includes the provider ETA.
- The customer is charged the quoted delivery amount once as part of the single checkout total.
- CSR delivery records 80% for the CSR and 20% for the house. Uber delivery records 100% as the provider liability.
- Actual tips, product commission, CSR delivery earnings, house delivery share, and Uber provider fees are separate immutable closeout lines.
- Product commission is 15–18% of discounted eligible product sales, net of completed line refunds. General Queue, membership, excluded, and unclassified lines earn no commission.
- Closeout is serializable and package-idempotent. Earning source keys are unique per tenant, preventing duplicate credits on retries.

## Isolated provider acceptance prerequisites

Do not use a production-configured connection. Provider calls must stop unless all applicable prerequisites exist:

- Uber Direct: a separate approved sandbox customer/account, sandbox client ID and secret, sandbox pickup location/contact, sandbox-only webhook signing key and registered HTTPS webhook URL, and dispatch enabled only in the isolated sandbox tenant. Verify quote/ETA, create, cancel, status/tracking, signature rejection, and duplicate event replay there.
- PayPal: separate sandbox business and buyer accounts, sandbox client ID/secret, registered sandbox webhook ID/URL, and isolated test orders. Verify create/capture, signed webhook replay, duplicate capture/event handling, and sandbox refunds.
- WooCommerce/CJ: an isolated WooCommerce test store with test-only API keys and webhook secret, plus a CJ sandbox/test account or provider-approved test mode. The Woo order for an already-paid MyOrder order must use a prepaid/no-collection gateway/status so Woo/CJ fulfillment cannot collect a second customer payment. Verify idempotent order export and fulfillment/tracking sync.

The PR does not enable production payments, dispatch, webhooks, product mappings, or provider settings.

## Jerry catalogue reproduction (read-only)

No authenticated Jerry session or safe request IDs are stored in this repository. Jerry can reproduce without sharing credentials: sign in normally, open the failing catalogue/product option once, and send only the response status and the `x-request-id` (or `x-correlation-id`) from the catalogue response and its product-options response. Include the approximate timestamp and affected product name; do not send cookies, authorization headers, tokens, or screenshots containing them.
