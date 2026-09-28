# Receipt Phase 1 — tenant scope of print configuration

Status: findings and proposed design. The migration below is **not** applied
and is deliberately kept out of `lib/db/drizzle/` so the migrate job cannot
pick it up. It needs review before it is added as a numbered migration.

## Finding

`print_settings` is a single, global row (no `tenant_id`). It is read with
`select … limit 1` by `getSettings()` (`lib/printService.ts`) and by
`loadOrCreateSettings()` (`routes/admin-printers.ts`), and written by
`PATCH /api/print/settings` and `PATCH /api/admin/printers/settings`.

Both writers are admin-only but not tenant-filtered, so an admin of any tenant
can change receipt presentation **and** automatic printing for every tenant.
Production currently has one tenant (id 1), so there is no live cross-tenant
exposure today; the model is still wrong for a multi-tenant platform.

## What each setting is, and where it should live

| Setting (print_settings) | Category | Already tenant/location-scoped elsewhere? | Target |
|---|---|---|---|
| `brandName`, `footerMessage` | presentation | yes: `tenant_settings.public_business_name`; footer = template `thankYou`/`customText` | tenant receipt template |
| `paperWidth` (receipts) | presentation | yes: `print_templates.paper_width` (per tenant); physical width also on `print_printers.paper_width` | template (layout) + printer (device) |
| `receiptTemplateStyle` | presentation | superseded by `print_templates.template_json` | tenant receipt template |
| `includeOperatorName` | presentation | superseded by template `csr` block (enable/disable) | tenant receipt template |
| `showDiscreetNotice` | presentation | superseded by template `customText` block | tenant receipt template |
| `includeLogo` | presentation | superseded by template `logo` block (Phase 2); currently has **no effect** in the legacy renderer | tenant receipt template |
| `labelTemplateStyle` | presentation (labels) | `print_templates` (jobType `label`) | tenant label template |
| product-name mode (`admin_settings.receipt_line_name_mode`) | presentation | **already per tenant** (`admin_settings.tenant_id`) | unchanged |
| business address / phone / timezone | presentation data | **already per tenant** (`tenant_settings`) | unchanged; read by `loadReceiptData` |
| printers, bridges, routes, shift/location assignments | printer/routing | **already tenant (and location) scoped**: `print_printers`, `print_bridge_profiles`, `print_routes`, `shift_print_assignments`, `operator_print_profiles` | unchanged |
| `receiptEnabled/Method/PrinterName`, `labelEnabled/Method/PrinterName`, `lastTestResult` | legacy printer config | legacy "simple" direct/local-CUPS surface (`/api/admin/printers/*`), superseded by the registered-printer model | deprecate with the legacy direct-print paths |
| `autoPrintOrders`, `autoPrintReceipts`, `autoPrintLabels` | operational control | **not scoped — global** | per-tenant operational row (migration below) |
| `retryBackoffBaseMs`, `staleJobMinutes`, `alertOnLabelFailure` | operational (platform) | global by nature (worker behaviour) | may stay global |

## Phase 1 approach (no migration needed)

Receipt presentation is now tenant-scoped through the tenant's own active
default receipt template (`print_templates`, `tenant_id`, `job_output =
'receipt'`, `is_active`, `is_default`) plus `tenant_settings` for business
identity. The global `print_settings` presentation fields are only used by the
legacy fallback receipt, which keeps today's output unchanged until a tenant
saves a template. One tenant can never resolve, preview, modify or deactivate
another tenant's template (tested).

## Proposed migration (operational controls) — NOT APPLIED

Smallest backward-compatible path for the automatic-print flags:

```sql
-- 1. Per-tenant operational print controls. Absent row = automatic printing off.
CREATE TABLE tenant_print_controls (
  tenant_id           integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auto_print_orders   boolean NOT NULL DEFAULT false,
  auto_print_receipts boolean NOT NULL DEFAULT false,
  auto_print_labels   boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  integer
);

-- 2. Carry today's global values to every existing tenant (production: f/f/f).
INSERT INTO tenant_print_controls (tenant_id, auto_print_orders, auto_print_receipts, auto_print_labels)
SELECT t.id, s.auto_print_orders, s.auto_print_receipts, s.auto_print_labels
FROM tenants t CROSS JOIN (SELECT * FROM print_settings ORDER BY id LIMIT 1) s
ON CONFLICT (tenant_id) DO NOTHING;
```

Code changes that would accompany it (a separate, reviewed change):

- `getPrintControls(tenantId)` reads `tenant_print_controls`, defaulting to all
  `false` (fail safe) when the row is missing.
- Order, shift and label automatic paths call it with the order's/shift's
  tenant instead of the global `getSettings()` flags.
- `PATCH /api/print/settings` and `/api/admin/printers/settings` write the
  caller's tenant row only; the global columns become read-only legacy and are
  dropped in a later migration after one release.

Rollback: the new table is additive; reverting the code falls back to the
unchanged global columns.
