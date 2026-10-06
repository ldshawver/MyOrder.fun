# Pre-launch test-order recovery

`voidPrelaunchTestOrder` is an internal, admin/global-admin-only operation for
synthetic orders created before the movement ledger existed. It is not a
generic status or inventory repair endpoint.

The operation locks the tenant-scoped order and its reservations in one
transaction, rejects captured/external payments, releases `reserved` holds,
and posts an immutable `correction` increase for each confirmed legacy
consumption. The correction references the order and reservation through
`sourceType=prelaunch_test_order_void`, `sourceId`, `orderId`, and a scoped
idempotency key. Existing movements/audit rows are never edited or deleted.

Legacy deductions have no trustworthy purchase cost. The movement ledger
therefore treats these corrections as `unknown_baseline`: quantity is restored
physically, but no unit cost, inventory value, WAC, or COGS is invented. The
valuation state remains unknown until a legitimate cost-establishing receipt is
posted. A known valuation state is rejected rather than silently assigning a
current WAC.

Reservation status becomes `reconciled` after a correction. Replays are
identified by the recovery idempotency key and produce no second movement or
audit event. Any inconsistent reservation or payment evidence aborts the
entire order transaction.
