-- Phase 1 order-state reconciliation report.
-- Usage: psql "$DATABASE_URL" -f scripts/sql/order_state_reconciliation.sql

WITH canonical_orders AS (
  SELECT
    o.id,
    o.tenant_id,
    o.customer_id,
    o.status,
    o.fulfillment_status,
    o.payment_status,
    o.total::numeric AS order_total,
    o.assigned_shift_id,
    CASE
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('draft','submitted','in_progress','preparing','ready','completed','cancelled','refunded','reconciliation_required')
        THEN COALESCE(o.fulfillment_status, o.status)
      WHEN COALESCE(o.fulfillment_status, o.status) = 'pending' THEN 'submitted'
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('accepted') THEN 'in_progress'
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('processing') THEN 'preparing'
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('ready_behind_gate','courier_arrived') THEN 'ready'
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('complete','delivered','handed_off') THEN 'completed'
      WHEN COALESCE(o.fulfillment_status, o.status) IN ('voided','archived') THEN 'cancelled'
      ELSE 'reconciliation_required'
    END AS canonical_lifecycle
  FROM orders o
), inventory_deductions AS (
  SELECT
    oi.order_id,
    COUNT(*) FILTER (WHERE elem IS NOT NULL) AS deduction_rows,
    COUNT(DISTINCT CONCAT(elem->>'locationId', ':', oi.catalog_item_id, ':', elem->>'quantity')) FILTER (WHERE elem IS NOT NULL) AS distinct_deduction_rows
  FROM order_items oi
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(oi.inventory_deductions, '[]'::jsonb)) elem ON true
  GROUP BY oi.order_id
), payment_totals AS (
  SELECT order_id, SUM(amount::numeric) AS cash_ledger_total, COUNT(*) AS cash_ledger_rows
  FROM cash_ledger_entries
  GROUP BY order_id
), shift_cash_totals AS (
  SELECT id AS shift_id, COALESCE((payment_totals_json->>'cash')::numeric, 0) AS shift_cash_total
  FROM lab_tech_shifts
)
SELECT 'lifecycle_fulfillment_conflict' AS issue, c.*
FROM canonical_orders c
WHERE c.fulfillment_status IS NOT NULL AND c.status IS NOT NULL AND c.status <> c.fulfillment_status
  AND NOT (c.status = 'submitted' AND c.fulfillment_status = 'submitted')
UNION ALL
SELECT 'completed_unpaid' AS issue, c.*
FROM canonical_orders c
WHERE c.canonical_lifecycle = 'completed' AND c.payment_status <> 'paid'
UNION ALL
SELECT 'paid_nonterminal' AS issue, c.*
FROM canonical_orders c
WHERE c.payment_status = 'paid' AND c.canonical_lifecycle NOT IN ('completed','cancelled','refunded')
UNION ALL
SELECT 'duplicate_inventory_deduction' AS issue, c.*
FROM canonical_orders c
JOIN inventory_deductions d ON d.order_id = c.id
WHERE d.deduction_rows > d.distinct_deduction_rows
UNION ALL
SELECT 'shift_total_payment_mismatch' AS issue, c.*
FROM canonical_orders c
JOIN payment_totals p ON p.order_id = c.id
LEFT JOIN shift_cash_totals s ON s.shift_id = c.assigned_shift_id
WHERE c.assigned_shift_id IS NOT NULL
  AND p.cash_ledger_total > COALESCE(s.shift_cash_total, 0)
ORDER BY issue, id;
