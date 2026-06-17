# POS Production Readiness Review — 2026-06-17

## Scope
Repo-side stabilization review for MyOrder.fun POS / ordering flows: customer ordering, safe checkout naming, CSR Start Shift / End Shift, inventory boxes, receipt/print queues, catalog import/editing, admin/supervisor controls, Document Hub security, repo audit guardrails, and deployment notes.

## Completed repo-side fixes
- **Document Hub security:** asset routes require authentication, DB-user loading, approval checks, tenant-aware per-action authorization, and manager-only create/version/archive/audit operations. Supervisors have no broad document-management access and require explicit document permissions for operational view/download/print/edit-metadata actions.
- **Document Hub audit coverage:** download, print, metadata, version, and archive actions write safe audit entries without raw document contents. Backend routes may remain available only when auth, tenant scope, and permissions are enforced; Document Hub should not be exposed in active MyOrder navigation unless a product decision explicitly enables that protected surface.
- **Auth/session hardening:** the auth layer keeps Clerk metadata sync, approved-user enforcement, pending/rejected/deactivated blocking, tenant/company assignment checks, role normalization including `tenant_admin`, staff-role compatibility, anti-enumeration-safe failures, and safe JSON failures for unauthorized/forbidden users.
- **Catalog visibility repair:** uploaded/local Alavont rows are visible even when legacy mapping left `isWooManaged=true`; only true WooCommerce storefront rows (`merchantProductSource='woo'` with a Woo product id) are excluded from Alavont catalog and inventory views.
- **Vendor stock parsing:** import stock labels such as `In Stock`, `Available`, and unknown non-empty labels remain visible by default instead of silently hiding uploaded products. Invalid, unsafe, or negative authoritative quantities should still be rejected server-side.
- **Inventory source of truth:** `inventory_balances` is the operational quantity source for product/location counts. Catalog fields such as `catalog_items.stock_quantity` / `stockQuantity`, `inventory_amount` / `inventoryAmount`, and `par_level` are mirrors recomputed after inventory balance changes.
- **Order transaction behavior:** order creation uses transaction-based inventory handling with an atomic `quantity_on_hand >= requested quantity` decrement and returns a 409 response on insufficient inventory so the order and decrement roll back together. Full DB-backed concurrency/load testing is still required.
- **CSR inventory flow:** Start Shift / End Shift wording remains UI-compatible while backend route names stay stable (`/api/shifts/clock-in`, `/api/shifts/clock-out`). CSR clock-in pulls box/location quantities from tenant-scoped `inventory_balances` when available, and manual ending-count overrides update tenant-scoped balances before catalog mirrors are recomputed.
- **Receipts & Printers:** receipt/reprint and printer administration are centralized through the admin print/receipt pages and API print job routes; live hardware bridge validation remains required.
- **Navigation cleanup:** current MyOrder navigation should stay focused on POS/admin/staff flows with no SMS & Calls, no unrelated MyPayLink/LUXit modules, no duplicate Integrations entry, and no unprotected document surfaces. Contractor/business document tools must stay permission-gated if retained.
- **Web Editor naming:** visual editing should be referred to as Puck/Web Editor in MyOrder documentation and UI copy.
- **Repo audit scanner:** `scripts/audit-secrets.sh` remains the repository secret-audit guardrail and should avoid raw recursive secret scans that produce noisy false positives while still blocking real-looking secrets.
- **Build defaults:** mockup sandbox builds default `PORT=5000` and `BASE_PATH=/` for non-interactive builds.

## Catalog count verification still required after deploy
Automated regression coverage now protects the likely missing-product root cause, but production acceptance requires live counts after deployment:
- Imported/uploaded rows: expected 35.
- Visible Alavont products: expected 35 minus only intentionally archived, disabled, or out-of-stock-hidden rows.
- Verify matching product sets in customer catalog, edit catalog, CSR checkout product search/form, CSR box inventory check-in, and admin inventory.
- Capture counts for total imported products, hidden archived, hidden inactive, hidden true WooCommerce source, and visible Alavont products.
- If persistent legacy flags need normalization, run `/api/admin/catalog/reclassify-local` as an authenticated admin and record the response.

## Deployment workflow notes
- Target path: `/opt/alavont/deploy`.
- Compose project/name: `alavont`.
- Safe deployment order:
  1. `docker compose build --pull`
  2. `docker compose up -d db`
  3. `docker compose run --rm migrate`
  4. `docker compose up -d api platform nginx`
- Tailscale/GitHub Actions deployment should use OAuth with `tag:github-actions`, default operator `serveradmin`, and support `VPS_USERNAME || VPS_USER || serveradmin` for VPS user resolution.
- Deployment workflow should log the selected VPS host, port, deploy path, and compose project before connecting.
- Do not claim a live VPS deployment was performed unless workflow logs prove it.

## Live deployment checks still required
- Authenticated smoke test with an approved Clerk admin/CSR session.
- Customer order placement through pickup and delivery selections.
- CSR Start Shift / End Shift with assigned box, printer assignment, inventory confirmation, and routed order handling.
- Supervisor checkout, discrepancy review, commission/deposit review, and receipt reprints.
- Physical printer validation for USB/USB-C/Bluetooth/Raspberry Pi bridge paths.
- Live payment settlement validation for Stripe-supported payments and manual confirmation flows for Cash, Venmo, Cash App, and Apple Pay.
- Courier dispatch validation for configured delivery providers.
- Document Hub manual verification for tenant isolation, manager-only sensitive actions, audit entries, and absence of raw document contents in audit payloads.
- Catalog visibility/stock parsing manual verification against a real 35-row upload and the customer catalog, edit catalog, CSR checkout form, CSR box check-in, and admin inventory views.

## Known follow-up risks
- Do not mark the overall POS production-ready until live catalog counts, authenticated smoke tests, payment/courier credentials, and physical printer/Raspberry Pi bridge validation are completed and documented.
- DB-backed concurrency testing is still needed to prove high-contention order creation cannot oversell inventory beyond the transaction-level atomic decrement guard.
- Document Hub is repo-side hardened, but production readiness still requires live role/tenant/manual audit verification with real admin, supervisor, CSR, normal-user, and cross-tenant sessions.
- Do not claim full catalog import/export undo, banner upload management, disclaimer versioning UI, notification preference enforcement, or deeper AI Concierge persistence is complete unless actual code and tests are added.
- Printer bridge queueing exists, but production readiness depends on live Raspberry Pi/bridge and printer hardware tests.
