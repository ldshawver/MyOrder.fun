# Admin/POS/security supporting PR notes

This PR is a **partial supporting admin/POS/security regression PR**. It must not be used to mark POS operational by itself.

## What this PR verifies

- Migration `0027_orders_shift_schema_drift.sql` is idempotent because every schema change uses `ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`.
- Migration `0027_orders_shift_schema_drift.sql` is non-destructive: it does not use `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, or table-rewrite data backfills.
- The migration only adds missing order routing/shift columns and indexes needed by current shift/order code, including `orders.assigned_shift_id`.

## Import blocker status and remaining live proof

- It now includes an importer-side duplicate Product Master repair before import attempts run.
- Automated tests prove that a 35-row Product Master import creates 140 `inventory_balances` rows after duplicate repair.
- It does **not** prove the live customer → CSR → supervisor POS flow.
- It does **not** prove Shift/Queue works live after deploy.

## Required production verification before calling POS operational

1. Take a production database backup.
2. Run migration `0027_orders_shift_schema_drift.sql` against production.
3. Verify the migration is idempotent by running it a second time successfully.
4. Verify `orders.assigned_shift_id` exists.
5. Verify `/api/shifts/clock-in` no longer returns a 500.
6. Verify Shift/Queue loads starting inventory.
7. Run the Product Master import on the live duplicate dataset.
8. Verify the expected 35 imported products create 140 `inventory_balances` rows in live SQL.
9. Run a live customer → CSR → supervisor POS flow.

## Screenshot/security limitation

Privacy protections in this PR are deterrence only. Websites cannot fully prevent OS-level screenshots, screen recordings, or external camera photos.
