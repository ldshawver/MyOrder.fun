# POS Production Readiness Review — 2026-06-15

## Scope
Reviewed the current MyOrder.fun codebase against the requested mobile-first POS / ordering acceptance criteria: customer ordering, dual Alavont/safe checkout display, CSR order routing, inventory boxes, shift start/end, receipts, print bridge, catalog import/editing, supervisor/admin controls, reporting, and security.

## What already exists
- Express API is mounted under `/api` with health probes, global rate limiting, Clerk auth middleware, JSON API 404 handling, and route modules for catalog, orders, payments, shifts, print, import, inventory, reports, settings, users, audit, feedback, and integrations.
- Database schemas and migrations already include users/roles, catalog dual-brand fields, orders/order items, payments, inventory locations/balances, shifts/shift inventory, print jobs/printers/settings, audit logs, settings, notifications, and visual editor pages.
- Customer checkout already normalizes the cart server-side before order/payment operations so public/internal product names do not leak into merchant payment payloads.
- Catalog import supports CSV/XLSX and the admin import aliases documented in the earlier POS audit.
- CSR shift, box assignment, inventory snapshot, closeout, supervisor checkout, print queue, reprint, restock slip, and reporting routes are present.
- Raspberry Pi / bridge print support exists in `deploy/print-bridge` and API-side print routing can queue, retry, and reprint jobs.

## Gap report / risks found
| Area | Status | Notes |
| --- | --- | --- |
| End-to-end hardware validation | Blocked | Physical USB/Bluetooth/Raspberry Pi printers were not available in this environment, so actual paper output cannot be certified here. Queue/reprint logic can be tested automatically. |
| Live payments/couriers | Blocked | Stripe, Apple Pay, Venmo, Cash App, and courier credentials/devices are not available in this environment. Digital-method selection and fee calculations can be tested, but live settlement/courier dispatch requires production credentials. |
| Authenticated live smoke | Blocked | Requires a live Clerk JWT/admin session and deployed environment access. |
| Full manual browser QA | Blocked | Browser/device/hardware credentials are not available here. Checklist below must be executed by an operator before declaring production complete. |

## Required operator setup for blocked validations
1. Configure Clerk and sign in as an approved admin/supervisor.
2. Export a live token for smoke tests:
   ```bash
   export BASE_URL="https://myorder.fun"
   export CLERK_JWT="$(# paste window.Clerk.session.getToken() output)"
   bash scripts/pos-smoke.sh
   ```
3. Configure production payment/courier environment variables before testing live digital settlement/courier dispatch.
4. Configure physical print queues or bridge endpoints, then verify all receipt/reprint paths from the admin/staff UI.

## Manual QA checklist still required before production sign-off
- Customer: browse catalog, add cart items, confirm all-sales-final, verify safe checkout names/images/descriptions, pickup/delivery, cash/digital methods, 15% digital fee display, submit order, order number, status/countdown.
- CSR: login, start shift, assign Box 1/2, confirm inventory/par/printer, receive routed order, print expo/customer receipts, mark ready, end shift with actual inventory.
- Supervisor/admin: checkout CSR, approve/adjust commission, review discrepancies/charges, print deposit/restock/shift/commission/inventory receipts, confirm routing returns to general account.
- Catalog: CSV import, Excel import, manual product add/edit, sale price, category/name/description/image, safe fields, inventory by location, par levels.
- Security: unauthenticated admin routes return JSON 401/403, staff-only routes reject ordinary users, uploads reject invalid files, no frontend secrets are exposed.

## Build defaults
`artifacts/mockup-sandbox/vite.config.ts` now defaults missing `PORT` to `5000` and missing `BASE_PATH` to `/`, so `pnpm run build` works in local/non-interactive environments without extra variables.
