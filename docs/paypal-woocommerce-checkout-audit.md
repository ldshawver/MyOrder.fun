# PayPal and WooCommerce checkout audit

Reviewed 2026-10-28 at main revision `16821278a5af3b6fdb82483cb67cc8dd94a650a3`.

## Verified in source

- Customer checkout creates one MyOrder order and takes payment through the
  PayPal provider flow. `PaymentService.create` locks by tenant/order, rejects
  a paid order, resumes a durable attempt after refresh, snapshots the amount,
  and uses the persisted attempt identity for capture. Capture is idempotent
  and finalizes the order and inventory in a transaction.
- The PayPal webhook requires the original bounded raw body, resolves a
  candidate tenant from a recorded provider identity, verifies the signature
  against that tenant's configured environment, and durably deduplicates
  provider events. Refunds require the `orders.refund` permission and use
  durable idempotency/reconciliation records.
- The client exposes PayPal checkout only when the server reports the tenant
  configuration enabled. No live payment configuration was changed or
  inspected during this audit.
- WooCommerce product synchronization exists, but the current PayPal capture
  and order fulfillment paths do not call `createWooOrder`; the helper has no
  caller in the current main tree. This avoids an automatic second Woo checkout
  or charge today, but it also means this audit did not verify MyOrder-to-Woo
  order/fulfillment synchronization for paid Woo/CJ line items.
- The checkout payment is initiated once in MyOrder. This is a source-code
  finding, not evidence of a completed provider sandbox lifecycle.

## Validation evidence and limits

The focused local API suite passed 8 files / 86 tests: PayPal provider,
payment reservation lifecycle, signed webhook retries, refund durability,
Uber Direct client/state, shift closeout arithmetic, and Woo safe HTTP.
These tests use mocks/fixtures. Repository evidence in
`docs/myorder-release-gates-2026-10-02.md` also records staging PayPal attempts
and explicitly says a complete sandbox browser approval, capture, and webhook
acceptance was not established. No real or sandbox transaction was initiated
for this review.

## Required before production configuration

1. In the approved secret manager, confirm the PayPal sandbox client ID,
   client secret, and webhook ID are present for the intended tenant. Report
   only presence; never copy values into source, logs, or review comments.
2. In PayPal's sandbox dashboard, verify the webhook is registered for the
   sandbox app and points to the intended sandbox endpoint.
3. With a dedicated test customer and disposable sandbox order, run one
   approval/capture, replay the same capture request, deliver a valid signed
   webhook twice, and verify one capture and one local paid transition.
4. Exercise a sandbox refund and its duplicate request, then reconcile the
   provider and local records. Confirm inventory/reservations and fulfillment
   state remain consistent.
5. Decide and test the Woo/CJ fulfillment contract before adding automatic
   Woo order creation. The Woo order must be a fulfillment handoff for the
   already-paid MyOrder order, with an immutable MyOrder identity and no
   customer-facing Woo checkout or second collection. Test duplicate handoff,
   timeout/reconciliation, partial Woo/CJ line items, and provider webhook
   behavior in a Woo sandbox first.

## Required paid Woo/CJ handoff contract

The current `createWooOrder` helper is not safe to wire into capture as-is. It
posts a `processing` order without a durable dispatch record, paid-state
semantics, customer shipping data, or timeout reconciliation. The focused
implementation should use this contract:

- MyOrder remains merchant of record and is the only customer checkout. A Woo
  order is created only after MyOrder has durably finalized payment, and only
  for Woo/CJ lines. It must never redirect the customer to Woo or invoke a Woo
  payment gateway.
- Persist a tenant/order-scoped fulfillment outbox row before the network call,
  with a unique immutable MyOrder order identity, payload fingerprint, attempt
  state, and eventual Woo order ID. Retries reuse that row. An ambiguous timeout
  is reconciled by the immutable identity before any further POST; it is never
  treated as permission to create a second Woo order.
- Create the Woo order with `set_paid: true`, an explicit external payment
  method/title such as `myorder` / `Paid in MyOrder`, and a non-secret immutable
  MyOrder payment reference. `set_paid` records that payment was collected
  elsewhere; it must not initiate another collection. Send the authoritative
  shipping recipient/address and the exact Woo product/variation quantities.
  Do not send credentials, provider tokens, or internal cost data as metadata.
- Store the immutable identity in a dedicated Woo metadata key and enforce one
  local handoff per MyOrder order. Before retrying an unconfirmed POST, query
  Woo for that identity and attach the existing order if present. A conflicting
  payload or multiple matches is a manual-reconciliation failure, not a retry.
- Accept signed, tenant-scoped Woo webhooks only for fulfillment/status and
  tracking changes. Deduplicate by provider event/delivery identity and reject
  regressions. Woo/CJ fulfillment updates must not mark MyOrder payment paid,
  create/capture PayPal orders, or alter non-Woo pickup/courier lines.
- Refund authority remains in MyOrder and its original tender records. A Woo
  refund or cancellation event may stop/reconcile fulfillment, but must not
  issue a second customer refund automatically. Partial fulfillment and refund
  quantities require explicit line-level mapping and idempotency.

The Woo status should advance to the state required by the CJ sandbox only
after the paid handoff is accepted. That exact status/plugin trigger is an
external decision that must be confirmed in a disposable Woo/CJ sandbox; do
not assume every CJ connector consumes the generic `processing` state.

## Current gate

**Production payment configuration is not proposed.** Sandbox credentials,
webhook registration, a complete sandbox lifecycle, and Woo/CJ fulfillment
sync are not verified by this audit. Keep PayPal unavailable until the
required sandbox acceptance and the Woo/CJ handoff decision are complete.
