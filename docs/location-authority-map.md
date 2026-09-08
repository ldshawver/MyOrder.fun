# Location authority map (Slice 4)

`inventory_locations` is the canonical tenant-scoped inventory location authority. Inventory receipts, movements, balances, reservations, transfers, stock-grid selectors, locations UI, printing references, and queue cash-session location IDs read this table.

The legacy `csr_boxes` table remains a compatibility/operational register authority for CSR assignment and cash-session register labels. Its rows are reconciled to `inventory_locations.csr_box_id` by migration 0055; normal inventory location creation and editing must not write it.

## Callers

- Canonical reads: `/api/admin/inventory-locations`, `/api/admin/inventory`, movement/receipt/transfer services, inventory balances, reservations, queue cash sessions, stock grid, inventory detail, locations selectors.
- Canonical writes: `/api/admin/inventory-locations` create/update/deactivate (tenant derived server-side).
- Legacy reads: `/api/admin/csr-boxes`, CSR clock-in and queue register option queries, order register resolution.
- Legacy writes: `/api/admin/csr-boxes` currently exists and is a Slice 4 deprecation target; it must not remain an independent normal management authority.
- Compatibility: `csr_boxes` fields (`slug`, assignment/register label, description, location, display order) remain readable until later CSR operational migration.

## Migration invariants

Each legacy CSR box has at most one canonical `csr_box` location for its tenant. Migration 0055 inserts missing mappings deterministically and preserves existing mappings; it does not delete legacy rows or invent cross-tenant links.
