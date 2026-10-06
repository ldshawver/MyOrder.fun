# Inventory write-path map — Phase 1 Slice 3 baseline

Inspection completed before the Slice 3 ledger implementation.  The current
physical-stock authority is `inventory_balances` for catalogue items and
`non_catalog_inventory_balances` for non-catalogue items.  `catalog_items`
stock fields and `inventory_templates.current_stock` are legacy/derived
representations and must not become a second authority.

## Current quantity-changing paths

| Current write path | File / endpoint or service | Tables mutated | Quantity authority / audit | Idempotency and concurrency | Replacement / integration plan |
| --- | --- | --- | --- | --- | --- |
| Catalogue checkout reservation | `routes/orders.ts` order creation -> `lib/inventoryReservations.ts#reserveCheckoutInventoryByOrderType` | `inventory_reservations` only | Reservation is a hold; it does **not** change physical quantity.  No movement audit is appropriate. | Deterministic reservation key; transaction and `FOR UPDATE` on candidate balance rows. | Retain as a separate reservation lifecycle.  It must never post a ledger movement or COGS. |
| Catalogue cash checkout consumption | `routes/orders.ts` order creation -> `confirmInventoryReservationsForOrder` | `inventory_reservations`, `inventory_movements`, `inventory_balances`, `order_items.inventory_deductions`, derived catalogue display totals | Reservation confirmation posts canonical `sale` movements; ledger updates balance, valuation, and audit atomically. | Deterministic reservation/movement keys; row/advisory locks and non-negative conditional update. | **Migrated.** No second deduction at delivered/template/queue stages. |
| Catalogue non-cash paid consumption | `routes/paypal-payments.ts` capture/reconcile and `routes/payments.ts` customer-credit -> `payments/inventory.ts#deductPaidOrderInventory` -> reservation confirmation | Same as cash checkout | Final payment confirmation posts canonical `sale` movements only for eligible assigned CSR orders; reservations alone do not change quantity. | Payment idempotency plus deterministic reservation/movement keys; confirmation locks balance rows. | **Migrated.** Customer-credit callers reuse their outer transaction; retries return existing movements. |
| Order status delivered legacy deduction | `PATCH /api/orders/:id` in `routes/orders.ts` when body status becomes `delivered` | `orders` only | No physical quantity mutation; final sale is posted by reservation confirmation. | N/A. | **Deprecated/read-only for stock.** |
| Catalogue import absolute stock set | `POST /api/admin/products/import` (and aliases) in `routes/import.ts` -> `upsertImportedInventoryRow` -> ledger correction service | `inventory_movements`, `inventory_balances`, `inventory_valuation_states`, `audit_logs`; template metadata projection | Absolute import delta is recorded as a typed baseline/correction movement; no fabricated receipt cost. | Confirmed transaction, idempotent source key, advisory/row locks. | **Migrated.** |
| Catalogue bootstrap of missing rows | `POST /api/admin/inventory/ensure-balances` -> `ensureAllInventoryRowsExistForTenant` -> `bootstrapMissingInventoryBalancesThroughAuthority` | Missing active product x required-location `inventory_balances` rows at `0` (and possibly standard locations) | Creates zero projections only; no stock changes or movement audit. | Transactional `INSERT ... ON CONFLICT DO NOTHING`. | Retain as projection bootstrap only.  It must not create movements or valuation. |
| Catalogue reconciliation | `POST /api/admin/inventory/reconcile-repair` -> `inventoryAuthority.reconcileInventoryState` | `inventory_reservations` status only | Releases expired/orphan reservations; it does not change physical balances. | Kernel transaction. | Retain as reservation repair.  A future physical correction must be an explicit ledger correction, never a silent reconcile write. |
| Legacy Stock Grid / Stock Levels editor | Platform `InventoryBalancesView` -> `PATCH /api/admin/inventory-balances/:id`; legacy catalog routes such as `PATCH /api/admin/inventory/balance/:productId/:locationId` | None: endpoints return `409` | Explicitly blocked outside bootstrap, importer, and checkout. | N/A. | Keep blocked; replace UI mutation affordances with typed ledger adjustment/receipt/transfer commands. |
| Legacy transfer endpoint | `POST /api/admin/inventory-transfers` in `routes/shifts.ts` | None: endpoint returns `409` | No current transfer authority. | N/A. | Replace with a canonical transfer operation that posts paired `transfer_out`/`transfer_in` rows atomically. |
| Receipt record | `inventory_receipts` from migrations `0047`/`0051` | None at runtime; table is currently dormant | There is no live receipt writer, balance update, cost snapshot, or audit path. | Table has tenant/idempotency uniqueness but no service uses it. | Evolve/use this receipt record together with the canonical ledger transaction; actual receipt unit cost and movement must be immutable. |
| Non-catalogue initial/adjust balance | `POST /api/admin/non-catalog/balances/adjust` in `routes/inventory.ts` | `inventory_movements`, `non_catalog_inventory_balances`, `inventory_valuation_states`, `audit_logs` | Canonical typed movement service is the quantity and cost authority. | Strict schema, idempotency, advisory/row locks, numeric SQL. | **Migrated.** |
| General Queue / CSR shift clock-in snapshot | `routes/shifts.ts` clock-in -> `shift_inventory_items` | `lab_tech_shifts`, `shift_inventory_items` | Snapshot/reporting evidence only.  Values may come from client snapshot, a location balance, or template default; no balance is changed. | No physical-stock lock needed. | Retain as a snapshot.  Do not treat it as receipt, transfer, sale, or COGS. |
| General Queue / CSR shift clock-out count | `routes/shifts.ts` clock-out -> `shift_inventory_items` | `shift_inventory_items` | Records expected/end/actual/count discrepancy only; no balance mutation. | No movement idempotency. | Retain as evidence.  A user-approved discrepancy disposition should later submit an explicit `waste`, `shrinkage`, or `correction` movement. |
| Admin inventory-template current stock edit | `PATCH /api/admin/inventory-template/:id` in `routes/shifts.ts` | None: physical stock fields are rejected/ignored | Template is configuration/projection only. | N/A. | **Deprecated for quantity.** |
| Inventory-template creation/seeding/synchronization | `routes/shifts.ts` template create/CSR seed; `routes/catalog.ts#syncCatalogItemToInventoryTemplate`; import template upsert | `inventory_templates.current_stock`, `starting_quantity_default` | Legacy defaults/compatibility projection are written from catalogue stock fields or import quantities; no balance change in most cases. | None. | Preserve non-quantity template metadata if still needed; stop copying physical stock into `current_stock` once ledger-backed projection is available. |
| Catalogue item creation | `POST /api/catalog` in `routes/catalog.ts` | `catalog_items.stock_quantity` and `inventory_amount` initialized from client `stockQuantity`; then template sync writes `current_stock` | Does **not** create a balance. These values are legacy fields and are not the physical authority. | Request validation but no inventory movement. | Inventory creation starts with zero ledger/balance stock.  Any initial stock must be a separately authorized receipt or baseline/adjustment movement. |
| Catalogue item update | `PATCH /api/catalog/:id` -> template sync | Catalogue metadata and legacy template projection | Stock fields are protected from normal PATCH, but sync copies existing legacy stock values into the template. | Standard catalog update transaction behavior; no physical balance mutation. | Keep supplier/default cost as metadata; do not allow this path to affect historical valuation or COGS. |
| Direct checkout helpers | `lib/inventoryBalances.ts#deductCheckoutInventoryByOrderType` / `deductCheckoutInventoryBackstockFirst` | Would reduce `inventory_balances` via authority | Helpers are currently unused by live routes. | Balance row authority locking if invoked. | Do not add new callers.  Deprecate/redirect internally to canonical sale posting if retained for compatibility. |
| Customer return / vendor return / usage / waste / damage / shrinkage / correction | `POST /api/admin/inventory/movements` | Relevant balance projection, `inventory_movements`, `inventory_valuation_states`, `audit_logs` | Controlled movement allowlist; server derives direction/cost and records immutable history atomically. | Strict schemas, tenant/item/location checks, row/advisory locks, and idempotency. | **Migrated.** Corrections compensate original rows; originals cannot be edited/deleted. |

## Read paths that must remain read-only

- `GET /api/admin/inventory`, `GET /api/admin/inventory-balances`, and the
  current Inventory UI read balance projections. They are not movement
  authorities.
- `GET /api/shifts/inventory-template?locationId=...` reads location balances
  for a shift view, otherwise falls back to template defaults. It does not
  write quantity.
- `inventory_transaction_log` / `replayInventoryTransaction` is a legacy,
  untyped snapshot journal. It is neither complete nor suitable as the new
  immutable valuation ledger.

## Slice 3 authority and double-deduction plan

1. Keep reservations separate from physical movement.  A reservation is
   released on cancellation/failure and produces no COGS.
2. Make one server-side movement service the only path permitted to change
   either balance table.  It writes the immutable movement, the relevant
   current balance, and the valuation projection in one transaction.
3. Redirect receipt, non-catalogue adjustment, sale confirmation, transfer,
   returns, usage, waste, damage, shrinkage, and correction commands to that
   service.  Cash orders are already consumed at order creation; non-cash
   orders are consumed at final payment confirmation, so neither may post a
   second movement at order completion/delivery.
4. Deprecate legacy template `current_stock` writes and the delivered-status
   template decrement.  Keep legacy pages/read projections only until their
   unique behavior is separately migrated.
5. Keep `catalog_items.cost_basis` and `non_catalog_inventory_items.unit_cost`
   as current/default supplier-cost metadata.  They are not receipt cost, WAC,
   or historical COGS authority.

## Baseline decision

Existing balances have no trustworthy historical movement or purchase cost.
Slice 3 migration is additive and must not manufacture receipt history or
silently assign `$0`/`cost_basis` as historical valuation.  Existing stock
will therefore remain explicitly `unknown_baseline` for valuation until an
authorized baseline/correction establishes a recognized cost.  New receipts
retain their actual purchase cost and establish weighted-average valuation for
inventory whose prior recognized quantity is known.
