# POS Production Readiness Review — 2026-06-15

## Scope
Reviewed the current MyOrder.fun codebase against the requested mobile-first POS / ordering acceptance criteria: customer ordering, dual Alavont/safe checkout display, CSR order routing, inventory boxes, shift start/end, receipts, print bridge, catalog import/editing, supervisor/admin controls, reporting, and security.

## What already exists
- Express API is mounted under `/api` with health probes, global rate limiting, Clerk auth middleware, JSON API 404 handling, and route modules for catalog, orders, payments, shifts, print, import, inventory, reports, settings, users, audit, feedback, and integrations.
- Database schemas and migrations already include users/roles, catalog dual-brand fields, orders/order items, payments, inventory locations/balances, shifts/shift inventory, print jobs/printers/settings, audit logs, settings, notifications, document/contractor hub, and visual editor pages.
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
| Document Hub security | Fixed in this change | Document asset routes now require authentication/approval plus per-action authorization. Global admins can access all tenants; admins/tenant admins are tenant-scoped; supervisors receive no broad management access and can only view/download/print/edit metadata when an explicit document permission grants that operational action. |
| Contractor signing public routes | Accepted | Token-based `/signing/contracts/:token` routes remain public by design. Admin document-library access is now protected separately. |
| Full manual browser QA | Blocked | Browser/device/hardware credentials are not available here. Checklist below must be executed by an operator before declaring production complete. |

## Implemented in this pass
- Added authentication, DB-user loading, approval, tenant scoping, and per-action authorization to Document Hub asset routes.
- Split Document Hub access so global admins can manage all tenants, admins/tenant admins can manage only their tenant, and supervisors are limited to explicitly granted operational document permissions; supervisors are denied create/version/archive/audit management actions.
- Added audit writes for download, print, metadata update, version, and archive actions without storing raw document contents in those audit payloads.
- Preserved existing token-based public signing routes while preventing unauthenticated Document Hub access.
- Updated Document Hub/Contractor Hub tests to exercise unauthenticated, user, CSR, supervisor, tenant-admin, global-admin, tenant-scope, public signing, and audit-log behavior.

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
- Security: unauthenticated admin/document routes return JSON 401/403, staff-only routes reject ordinary users, uploads reject invalid files, no frontend secrets are exposed.

## Document Hub permission policy confirmed in code
- `global_admin`: list/create/view/download/print/metadata/version/archive/audit across tenants.
- `admin` / `tenant_admin`: list/create/view/download/print/metadata/version/archive/audit only for documents whose `companyId` matches the user tenant.
- `supervisor`: no implicit Document Hub management access; list returns no broad corpus, and view/download/print/edit-metadata require an explicit `document_asset_permissions` grant in the same tenant. Version, archive, create, and audit-log access are denied.
- `customer_service_rep` / CSR and normal users: denied unless a future explicit document permission model grants a supported non-management action.

## Build defaults
`artifacts/mockup-sandbox/vite.config.ts` now defaults missing `PORT` to `5000` and missing `BASE_PATH` to `/`, so `pnpm run build` works in local/non-interactive environments without extra variables.

## Catalog visibility repair — 2026-06-16
- Corrected catalog/import/inventory filters so uploaded Alavont rows are not hidden just because a legacy import or mapping left `isWooManaged=true`; only real WooCommerce storefront rows (`merchantProductSource='woo'` with a Woo product id) are excluded from Alavont catalog and inventory views.
- Corrected stock-status parsing so vendor labels such as `In Stock`, `Available`, and unknown non-empty labels do not silently mark uploaded products unavailable and hide them from customer catalog/CSR inventory flows.
- Re-run or refresh catalog/import inventory views after deploy. Existing rows that were misclassified should now appear in catalog/edit-catalog without requiring a new upload; `/api/admin/catalog/reclassify-local` remains available as an explicit data repair endpoint if operators want to normalize flags permanently.

## Live catalog count verification required after deploy — 2026-06-16
This code path now has automated regression coverage for the misclassified-import case, true WooCommerce exclusion, and aligned in-memory visibility counts across customer catalog, edit catalog, admin inventory, and CSR check-in views. Final acceptance still requires an operator with production access to record live counts after deployment:
- Imported/uploaded rows: expected 35.
- Visible Alavont products: expected 35 minus only intentionally archived/disabled/out-of-stock-hidden rows.
- Verify matching product sets in customer catalog, edit catalog, CSR checkout search/form, CSR box inventory check-in, and admin inventory.
- Capture counts for hidden archived, hidden inactive, hidden true WooCommerce source, and visible Alavont products.
- If legacy flags still need permanent cleanup, run `/api/admin/catalog/reclassify-local` as an authenticated admin and record the response.
