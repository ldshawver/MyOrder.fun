# POS Production Readiness Gap Report

Reviewed June 18, 2026. This repository already contains substantial POS foundations: Clerk-backed auth and role gates, customer catalog/order routes, conversion preview for safe checkout copy, CSR shift APIs, inventory locations/balances, receipt/print job infrastructure, reports, and admin routes.

## Implemented in this change

- Hardened CSR order routing so an active CSR shift is eligible only after the CSR has a box assignment, confirmed starting inventory, confirmed par levels, and a printer assignment/ready signal.
- Updated shift clock-in to persist explicit readiness flags derived from submitted inventory snapshots and printer confirmation.
- Added regression tests for the routing readiness gate.

## Confirmed order routing behavior

1. The router first finds active CSR shifts, then filters them to shifts that are ready for orders: active shift, box assigned, inventory confirmed, par confirmed, and printer assigned.
2. If no ready CSR is found, the order remains unassigned and routes to the General Account fallback queue for `alavonttherapeutics@gmail.com`.
3. If exactly one ready CSR is found, the order routes to that CSR and their active shift.
4. If multiple ready CSRs are found, the configured routing strategy decides the selection: `supervisor_manual_assignment` keeps the order in the General Account/manual queue; `least_recent_order` picks the CSR whose accepted order is oldest; `round_robin`/default picks the CSR whose routed order is oldest.

## Remaining gaps / blockers

- End-to-end payment processing requires live Stripe/digital wallet credentials and payment-method settlement reconciliation.
- Courier dispatch requires configured Uber Direct credentials and production pickup location data.
- Hardware receipt printing requires assigned USB/Bluetooth/Raspberry Pi printers available on the deployment network.
- Browser manual QA was not completed in this non-interactive terminal session.
- A full security sign-off still needs deployment-specific checks for production environment variables, TLS, cookie settings, CSP, and operational audit retention.

## Manual QA checklist still required

1. Customer: browse catalog, confirm all-sales-final, verify safe checkout transformation, place pickup and delivery orders, verify 15% digital fee display and order countdown.
2. CSR: log in, start shift with Box 1/Box 2, confirm inventory/par/printer, receive routed order, print receipts, mark ready, clock out.
3. Supervisor/admin: upload CSV/XLSX menu, manually edit safe fields/inventory/par, checkout CSR, approve commission, print/reprint deposit/restock/summary receipts, verify routing returns to the general queue when no eligible CSR remains.
