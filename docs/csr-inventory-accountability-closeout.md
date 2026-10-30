# CSR inventory accountability at shift close

CSRs remain contractors. Shift closeout does not set employment status and does
not infer customer employee-discount eligibility from a CSR role or from client
input. Customer pricing and tax continue through the existing server-authoritative
checkout and jurisdiction rules; cash tender does not make merchandise non-taxable.

## Inventory calculation

For each shift inventory row, the server resolves the exact catalog item/variant
and assigned location. Expected quantity is:

`opening count + non-sale ledger movements during the shift - recorded shift sales`

The non-sale movement total includes receipts, transfers, returns, usage/loss, and
authorized adjustments already recorded in the append-only inventory ledger. The
CSR's clock-out count is retained independently. Only
`max(0, expected - counted)` is a shortage; overages produce no charge.

Every shortage line snapshots the item name, unit, opening/movement/sales/count
quantities, current retail price, 20% discount, 80% replacement value, and line
total. Missing counts, item/variant links, locations, and zero/invalid retail prices
block finalization. Inventory cost and another variant's price are never fallbacks.

## Review, inventory, and payout

A supervisor must provide a reason of at least ten characters and explicitly
confirm the reviewed shortage. Finalization runs in the existing serializable,
idempotent closeout transaction. Each shortage posts a `shrinkage` movement through
the authorized inventory ledger; it is not a customer order or sale and has no
customer sales tax.

Commission, customer tips, and completed CSR delivery earnings form gross payable.
Prior refund adjustments are applied under the existing rules. Audited inventory
accountability offsets are then capped at the remaining payable amount. Any unpaid
remainder uses the explicit `carry_forward_to_future_shift_payout` policy and is
applied oldest-first on a later closeout. Adjustment obligations, applications,
shortage lines, and price snapshots are immutable and tenant-scoped.

Cash reconciliation is separate. Opening cash, accountable cash-ledger activity,
expected cash, counted cash, variance, and deposit are snapshotted without treating
contractor payout or inventory offsets as cash received.

General Queue orders remain excluded from CSR product commission and its cash
sessions remain independently controlled and reconciled; this workflow reads only
orders and inventory rows assigned to the closing CSR shift.
