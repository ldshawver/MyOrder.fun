# Phase 1 Slice 3 — Inventory Movement Ledger: Cost and Valuation Requirements

This is a Slice 3 planning and acceptance requirement. It must not be implemented
until the Slice 2 browser acceptance gate is green. It applies to catalogue and
non-catalogue inventory and must not change production or staging before normal
Phase 1 acceptance gates are met.

## Cost authority

`catalog_items.cost_basis` may remain the current/default supplier cost, but is
not the historical valuation ledger. Every receipt preserves its immutable actual
unit purchase cost. Retail price, current/default cost, purchased unit cost,
inventory value, and COGS are distinct concepts.

Receipts record supplier, order/reference, date, item (catalogue or non-catalogue),
location, quantity, unit cost, extended cost, optional allocations, actor, source,
and an idempotency key. Use decimal/numeric money types; calculate extended cost
and inventory value server-side.

## Valuation and movements

The initial valuation method is weighted average cost:

`(existing_quantity * existing_average_cost + received_quantity * received_unit_cost) / new_quantity`

Balance quantity, average unit cost, and inventory value update transactionally
under row locking (or equivalent concurrency control). Concurrent receipts must
not lose quantity or corrupt valuation. Idempotent receipt identity must produce
one balance change, transaction entry, and audit result.

Completed sales/usage persist an immutable cost attribution so historical COGS,
gross profit, and margin never change when current supplier cost changes. Apply
the same authority to non-catalogue operational usage. Customer returns restore
the appropriate recognized cost; vendor returns remove quantity/value. Waste,
damage, shrinkage, and positive adjustments require explicit cost treatment,
reason, actor, location, and timestamp. Transfers preserve total value and create
no revenue or COGS.

## UI, reporting, and security

Authorized inventory views may expose stock, PAR, minimum order, average cost,
inventory value, current supplier cost, last purchase cost, and purchase history.
Customer catalogue surfaces and exports must never expose internal cost fields or
non-catalogue items. Reports/exports must support the existing date ranges and
include authorized inventory value, purchases, cost trends, COGS, gross profit,
margin, operational usage, waste/shrink cost, and vendor spend fields.

All cost calculations are server authoritative. Validate tenant, permission,
decimal precision, positive quantities, reasonable cost bounds, foreign keys,
idempotency, audit logging, and concurrency. Never accept client-submitted
average cost, inventory value, COGS, gross profit/margin, or extended receipt
value as authoritative.

## Slice 3 acceptance gates

Automated proof is required for receipt cost capture, multiple purchase prices,
weighted-average cost, inventory value, sale COGS, historical COGS immutability,
non-catalogue usage cost, transfer value preservation, waste cost, adjustment
cost, concurrent receipts, idempotent receipts, tenant isolation, authorized
report cost data, and catalogue/customer cost isolation.
