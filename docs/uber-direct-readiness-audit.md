# Uber Direct readiness audit

Reviewed 2026-10-28 at main revision `16821278a5af3b6fdb82483cb67cc8dd94a650a3`.

## Existing MyOrder implementation

The current code is an Uber Direct integration, not an Uber Eats ordering
integration. It already implements:

- Server-created customer quotes, storing the provider quote, fee, currency,
  expiration, address, and cart fingerprint. Checkout verifies the quote is
  current and matches the server-normalized cart/address; the customer response
  exposes Uber's quoted fee and ETA.
- A durable paid-order handoff. Payment only queues staff work; a courier is
  requested only after the order is ready, fully settled, dispatch is enabled,
  the tenant pickup location/contact is valid, and the stored quote identity
  matches. Expired quotes are refreshed only if fee and currency still match.
- Guarded create, cancellation, provider lookup/reconciliation, and
  tenant-scoped signed status webhooks with durable event deduplication.
  Ambiguous creates remain blocked until provider reconciliation; they cannot
  trigger an automatic second delivery.
- Local provider tests for quote/create identity, cancellation, signatures,
  invalid provider responses, delivery-state transitions, and reconciliation.

The focused local API suite passed 8 files / 86 tests (including the Uber
client/state tests). Repository evidence in
`docs/myorder-release-gates-2026-10-02.md` records a staging synthetic
authentication, quote, single create, readback, and cancel lifecycle using an
existing encrypted sandbox credential record. That is historical staging
evidence; this review did not access the secret record or rerun a provider
transaction.

The customer-facing tracking surface currently exposes courier status and
supports a customer-submitted Uber trip-share link for manually arranged
deliveries. The Uber Direct fulfillment record does not persist a provider
tracking URL. If the approved Direct account returns a customer-shareable URL,
test that behavior and add a safe, tenant-scoped field before promising a
provider tracking link.

## Setup that must be verified outside the repository

The application keeps tenant-scoped encrypted settings. Before a sandbox run,
an authorized operator must confirm these presence/status values in the admin
integration settings without copying secret values:

- Uber Direct sandbox customer ID and client ID;
- encrypted client secret present;
- encrypted webhook signing key present;
- an active Storefront pickup location selected, with a complete tenant
  business address, public business name, and support phone;
- sandbox environment selected, integration enabled, and staff dispatch
  enabled only for the controlled sandbox test.

The Uber Direct account must be approved for the intended region and API
access. The app requests the Direct OAuth scope `eats.deliveries`; this is the
Direct API scope and does not mean Uber Eats catalog/order integration. Register
the sandbox webhook URL in Uber's Direct developer dashboard and use that
account's signing key. Uber's official setup guidance covers [Direct account
onboarding](https://developer.uber.com/docs/deliveries/get-started),
[authentication](https://developer.uber.com/docs/deliveries/guides/authentication),
and [webhooks](https://developer.uber.com/docs/deliveries/guides/webhooks).

Current production or sandbox setting presence was **not verified** in this
read-only review. No settings were changed.

## Compensation and fulfillment-policy gaps

The checkout keeps the customer charge to the quoted Uber fee; the provider's
merchant billing is separate. A sandbox invoice/charge reconciliation is
needed to prove that Uber Direct receives the full quoted fee without adding a
second customer charge.

Two existing CSR accounting paths do not yet match the requested policy:

1. CSR delivery earnings currently credit **100%** of the calculated CSR
   delivery fee to the assigned shift at order creation, using a fire-and-forget
   update. The code does not wait for payment or delivery handoff and does not
   record the requested 80% CSR / 20% house split at delivery completion.
2. Shift commission currently uses paid order totals as its base. Those totals
   include delivery charges and customer tips; the closeout sets
   `employeeDiscountSales` to zero. It therefore does not demonstrate a
   commission based only on discounted product sales. General Queue orders are
   normally unassigned, but the closeout should explicitly exclude their route
   source as a defense-in-depth rule. The closeout stores this commission in
   legacy tip-named fields and deducts it from the cash deposit; it does not
   evidence a product-profit calculation. Customer tip amounts are recorded in
   the checkout snapshot but are not separately included in the shift payout
   calculation.

These require a focused transactional accounting change and regression tests
before operational use. The existing closeout and order state model needs to
be extended so commission, customer tips, and CSR delivery share are separate,
idempotent payout lines. This audit does not change historical shifts or
invent product-cost inputs.

## Sandbox acceptance checklist

After the setup above is confirmed, use only synthetic addresses/orders in the
Uber Direct sandbox:

1. Create a quote and verify MyOrder displays its returned fee and ETA.
2. Submit a checkout using that quote and verify server-side quote, cart,
   tenant, and address binding; verify no Woo/CJ item is submitted to Uber.
3. Set the synthetic order ready and paid, dispatch once, and replay the
   dispatch request. Confirm one provider delivery, exact quote fee/currency,
   and no second customer collection.
4. Test status webhook signature rejection, valid status transition,
   duplicate event replay, provider lookup/reconciliation, and cancellation.
5. Confirm Uber's sandbox billing/statement shows its quoted fee and reconcile
   against MyOrder's single checkout amount.
6. Test WooCommerce/CJ items remain on their shipping workflow, free pickup
   remains free, and MyOrder courier behavior is unchanged.
7. Validate the separate 80/20 delivery share, 100% customer-tip payout, and
   15–18% supervisor-selected commission on discounted product sales at shift
   close, with General Queue orders excluded and no customer price change.

**Production dispatch/configuration is not proposed.** Current configuration
presence, Uber account approval, registered webhook, current sandbox execution,
and the compensation accounting changes remain open gates.
