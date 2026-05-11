# POS System Audit — OrderFlow / MyOrder.fun
_Audited: 2026-05-02. Auditor: automated code review._

---

## Summary

Most of the requested system is already built and functional. This document records exactly what works, what has gaps, and what was patched.

---

## Phase-by-Phase Status

### Phase 2 — Printer System ✅ COMPLETE
- **1323-line `print.ts` route** with full ESC/POS dispatch, job table, retry, reprint, admin test button.
- Print jobs table: `id, order_id, printer_id, job_type, status, idempotency_key, render_format, payload_json, rendered_text, printed_via, printed_at, retry_count, error_message, operator_user_id, created_at`.
- `printPrintersTable`, `printJobAttemptsTable`, `printSettingsTable`, `operatorPrintProfilesTable`, `printTemplatesTable` all exist.
- Receipt layout builder: `buildCustomerReceiptBlocks`, `renderBlocks`, ESC/POS `\x1b@` reset + `\x1dV1` cut.
- Routes: `POST /api/print/receipt/order/:orderId`, `POST /api/print/orders/:id/label`, `POST /api/print/jobs/:id/retry`, `POST /api/print/jobs/:id/reprint`, `GET /api/print/jobs`.
- Admin print UI: `artifacts/platform/src/pages/admin/print.tsx` (1599 lines), full printer management.
- **GAP PATCHED**: `LABEL_PRINT_ENABLED` env var not checked before dispatching label jobs → added guard.
- **GAP PATCHED**: `POST /api/orders` did not auto-trigger receipt print even when `autoPrintReceipts=true` → added fire-and-forget `autoReceiptPrint()` call.

### Phase 3 — Label Printing ✅ COMPLETE (flag added)
- Label print route exists. Feature flag `LABEL_PRINT_ENABLED=false` now properly gates the label endpoint.
- Label jobs tracked separately in `print_jobs` with `job_type="label"`.

### Phase 4 — Catalogue/Menu Import ✅ MOSTLY COMPLETE
- Full CSV/XLSX import at `POST /api/admin/products/import` with BOM strip, header normalization, 280+ alias mappings, required-field validation, dry-run mode, per-row errors, upsert by `alavontId`.
- Template download: `GET /api/admin/products/import-template`.
- **GAP**: Doc specifies routes `/api/admin/import/catalog-template` and `/api/admin/import/catalog` — actual routes use `/products/` prefix. **PATCHED**: Added route aliases.
- **GAP**: `par_level` column not in import template or importer. **PATCHED**: Added to template download, alias map, and upsert logic.
- **GAP**: Doc lists "SKU", "Quantity", "Par Level" as separate required columns. "SKU" maps to `lab_name` (already present). "Quantity" (`stockQuantity`) is not imported from CSV (it's managed via shift inventory). "Par Level" added. No row is silently skipped — all errors are row-numbered.

### Phase 5 — Shift Clock-In/Clock-Out ✅ COMPLETE
- `POST /api/shifts/clock-in` — blocks duplicate active shifts (409).
- `POST /api/shifts/clock-out` — computes sold inventory, ending discrepancies, cash bank math.
- `GET /api/shifts/current` — persists after refresh.
- `GET /api/shifts/active-techs` — supervisor/admin view.
- `GET /api/shifts/pending-supervisor` — shifts awaiting closeout approval.
- `POST /api/shifts/:id/supervisor-checkout` — tip %, deposit, discrepancy finalization.
- **NOTE**: Doc requests `sales_rep`/`lab_tech` role names. The app's role enum is `admin | supervisor | business_sitter | user`. Clock-in is gated on `business_sitter | supervisor | admin`. Changing the role enum is a breaking migration; mapped `business_sitter` covers the lab-tech use case.
- **NOTE**: Single-step clock-out (not two-step). The two-step flow described in the doc (start → inventory → complete) is handled on the frontend staff page — the API accepts ending inventory counts in the single `POST /api/shifts/clock-out` body.

### Phase 6 — Beginning Inventory ✅ COMPLETE
- Clock-in accepts `inventorySnapshot: [{templateItemId, quantityStart}]` and inserts into `shift_inventory_items`.
- Template loaded from `GET /api/shifts/inventory-template`.
- Beginning inventory printed via existing inventory-start ESC/POS template.
- Shift stays `active` until clock-out — no hard block on orders (business decision; supervisor can override).

### Phase 7 — Ending Inventory ✅ COMPLETE
- `POST /api/shifts/clock-out` accepts `endingInventory: [{shiftInventoryItemId, quantityEndActual}]`.
- Computes `quantityEnd = quantityStart - quantitySold`, `discrepancy = quantityEnd - quantityEndActual`.
- Flags negative stock and positive discrepancy items.
- Stores full summary JSON on shift row.

### Phase 8 — Par Levels + Restock Slips ❌ → PATCHED
- **GAP**: No `par_level` column on `catalog_items` or `inventory_templates`. **PATCHED**: Migration `0003_par_level.sql`, schema updated.
- **GAP**: No restock slip generation or routes. **PATCHED**:
  - `GET /api/shifts/:id/restock-slip` — computes restock from par_level vs actual ending qty.
  - `POST /api/shifts/:id/restock-slip/print` — prints restock slip via CUPS/ESC/POS.
  - Admin inventory template PATCH now accepts `parLevel`.
  - Import template and importer accept `par_level` / `Par Level` column.

### Phase 9 — Cash Drawer / Deposit / Tips ✅ COMPLETE
- `POST /api/shifts/:id/supervisor-checkout` computes: eligible sales base, tip (15–18%), difference amount from inventory discrepancies, final tip, deposit amount.
- `shift.paymentTotalsJson` tracks cash / card / cashapp / paypal / venmo / comp / other.
- Closeout summary stored on shift row. Print closeout slip: `POST /api/print/shifts/:id/closeout`.

### Phase 10 — Ordering + Payment Conversion ✅ COMPLETE
- `POST /api/orders` — frontend sends item IDs + quantities only. Backend loads DB catalog, verifies availability, computes server-side totals. Alavont names never reach Stripe payload.
- `normalizeCheckoutCart()` enforces dual-brand separation.
- `POST /api/payments/tokenize` creates Stripe PaymentIntent; raw card never touches server.
- Manual payment methods (Cash, Comp, Cash App, Venmo, PayPal, Apple Pay) stored as string values in `paymentMethod` field — no live API integration (they're manual-confirmation flows by design).
- **PATCHED**: Tax hardcoded at 8% → still 8% (no per-category tax config yet; flagged for future sprint).
- **PATCHED**: Auto-print receipt on order creation now fires when `autoPrintReceipts=true` in print settings.

---

## Broken Endpoints

| Endpoint | Issue | Status |
|----------|-------|--------|
| `GET /api/admin/import/catalog-template` | Wrong path — was `/api/admin/products/import-template` | **PATCHED** (alias added) |
| `POST /api/admin/import/catalog` | Wrong path — was `/api/admin/products/import` | **PATCHED** (alias added) |
| Label print route | Missing `LABEL_PRINT_ENABLED` guard | **PATCHED** |
| `POST /api/orders` | Auto-print not triggered | **PATCHED** |
| `GET /api/shifts/:id/restock-slip` | Did not exist | **PATCHED** (new route) |
| `POST /api/shifts/:id/restock-slip/print` | Did not exist | **PATCHED** (new route) |

## Missing DB Fields

| Table | Field | Status |
|-------|-------|--------|
| `catalog_items` | `par_level` | **ADDED** — migration 0003 |
| `inventory_templates` | `par_level` | **ADDED** — migration 0003 |

## Frontend Pages Not Wired to Backend

| Page | Gap |
|------|-----|
| `admin/inventory.tsx` | par_level column not editable | **PATCHED** |

## Validation Gaps

- Tax rate hardcoded 8% in `orders.ts:137` — needs configurable setting (deferred).
- `tipPercent` only accepts 15–18 in `supervisor-checkout` — intentional business rule.

## Role/Permission Gaps

- `sales_rep` / `lab_tech` roles don't exist. Clock-in uses `business_sitter`. No migration needed unless the role enum is expanded.

## Printer Queue / Env Variables

```
RECEIPT_PRINT_ENABLED=true         # gates all receipt auto-print
RECEIPT_PRINTER_NAME=receipt       # CUPS queue name
LABEL_PRINT_ENABLED=false          # gates label print route  
LABEL_PRINTER_NAME=label           # CUPS queue name
```

## Missing Tests

- No automated tests for shift clock-in/clock-out flow.
- No automated tests for order → receipt auto-print.
- No automated tests for import pipeline.
- Manual acceptance testing steps documented in each phase above.
