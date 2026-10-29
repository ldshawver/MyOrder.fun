import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { z } from "zod";
import { postInventoryMovement } from "../lib/inventoryMovementLedger";
import { allocateCumulativeQuantityCents, allocateProportionalRefund, parseOriginalTenderAllocations, type OrderLineRefundTax, type OriginalTenderAllocation, type RefundTender } from "../lib/refundAccounting";
import { restoreCustomerCredit } from "../payments/customerCredit";
import { requireOnlinePayments } from "../payments/config";
import { loadTenantPaymentConfig } from "../payments/tenantConfig";
import { PayPalProvider } from "../payments/paypal";
import { PaymentService, PaymentServiceError } from "../payments/service";
import { calculatePostCloseoutCommissionRecovery, refundedCommissionBasisAfterCloseout } from "../lib/shiftEarnings";

const router = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const lineSchema = z.object({
  orderItemId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  disposition: z.enum(["RESTOCK", "DO_NOT_RESTOCK"]),
}).strict();
const bodySchema = z.object({
  lines: z.array(lineSchema).min(1).max(50),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().regex(/^return:[A-Za-z0-9._:-]{8,120}$/),
  preview: z.boolean().optional().default(false),
}).strict();

type Row = Record<string, unknown>;
const rows = <T extends Row>(value: unknown): T[] => Array.isArray(value) ? value as T[] : ((value as { rows?: T[] } | null | undefined)?.rows ?? []);
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const money = (n: number) => (n / 100).toFixed(2);

function storedLineTaxAllocations(snapshot: unknown): OrderLineRefundTax[] | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).lineTaxAllocations;
  if (!Array.isArray(value) || value.length === 0) return null;
  const allowed = (row: Record<string, unknown>) => ["lineIndex", "orderItemId", "catalogItemId", "quantity", "grossCents", "discountCents", "taxableBaseCents", "taxCents"]
    .every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
    && Number(row.orderItemId) > 0 && Number(row.catalogItemId) > 0 && Number(row.quantity) > 0
    && typeof row.taxable === "boolean"
    && Number(row.discountCents) <= Number(row.grossCents)
    && Number(row.taxableBaseCents) === (row.taxable ? Number(row.grossCents) - Number(row.discountCents) : 0)
    && (row.taxable === true || Number(row.taxCents) === 0);
  if (!value.every(row => row && typeof row === "object" && !Array.isArray(row) && allowed(row as Record<string, unknown>))) return null;
  const itemIds = value.map(row => Number((row as Record<string, unknown>).orderItemId));
  if (new Set(itemIds).size !== itemIds.length) return null;
  return value as OrderLineRefundTax[];
}

async function resolveOriginalAllocations(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: number, order: Row, immutableSnapshot?: unknown): Promise<OriginalTenderAllocation[] | null> {
  const totalCents = cents(order.total);
  const candidate = immutableSnapshot !== undefined ? immutableSnapshot : order.tax_snapshot;
  const snapshot = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : {};
  const exact = parseOriginalTenderAllocations(snapshot.originalTenderAllocations, totalCents);
  let allocations = exact;
  if (!allocations && snapshot.originalTenderAllocations == null) {
    // Compatibility path for older immutable schemaVersion-3 records. It only
    // accepts complete source amounts and verifies them against settlement ledgers.
    const tenderAllocation = snapshot.tenderAllocation && typeof snapshot.tenderAllocation === "object"
      ? snapshot.tenderAllocation as Record<string, unknown> : {};
    const creditCents = Number.isSafeInteger(tenderAllocation.customerCreditCents)
      ? Number(tenderAllocation.customerCreditCents) : cents(order.customer_credit_applied);
    const externalCents = Number.isSafeInteger(tenderAllocation.externalTenderCents)
      ? Number(tenderAllocation.externalTenderCents) : totalCents - creditCents;
    const method = String(snapshot.tender ?? order.selected_payment_method ?? order.payment_method ?? "").toLowerCase();
    const externalTender: RefundTender | null = method.includes("paypal") ? "paypal" : method.includes("cash") ? "cash" : null;
    if (Number.isSafeInteger(creditCents) && creditCents >= 0 && Number.isSafeInteger(externalCents) && externalCents >= 0
      && creditCents + externalCents === totalCents
      && (externalCents === 0 || externalTender !== null)) {
      allocations = [
        ...(creditCents > 0 ? [{ tender: "customer_credit" as const, amountCents: creditCents }] : []),
        ...(externalCents > 0 && externalTender ? [{ tender: externalTender, amountCents: externalCents }] : []),
      ];
    }
  }
  if (!allocations || cents(order.customer_credit_applied) !== (allocations.find(row => row.tender === "customer_credit")?.amountCents ?? 0)) return null;
  const credit = allocations.find(row => row.tender === "customer_credit")?.amountCents ?? 0;
  if (credit > 0) {
    const settled = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(abs(amount)),0)::numeric AS amount FROM customer_credit_ledger WHERE tenant_id=${tenantId} AND order_id=${Number(order.id)} AND entry_type='payment_consumption'`))[0];
    if (cents(settled?.amount) !== credit) return null;
  }
  const cash = allocations.find(row => row.tender === "cash")?.amountCents ?? 0;
  const paypal = allocations.find(row => row.tender === "paypal")?.amountCents ?? 0;
  if (cash > 0) {
    const settled = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(amount),0)::numeric AS amount FROM cash_ledger_entries WHERE tenant_id=${tenantId} AND order_id=${Number(order.id)} AND entry_type='cash_sale_closeout'`))[0];
    if (cents(settled?.amount) !== cash) return null;
  }
  if (paypal > 0) {
    const settled = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(pc.amount),0)::numeric AS amount FROM payment_captures pc JOIN payment_attempts pa ON pa.tenant_id=pc.tenant_id AND pa.id=pc.payment_attempt_id WHERE pa.tenant_id=${tenantId} AND pa.order_id=${Number(order.id)} AND pc.provider='paypal'`))[0];
    if (cents(settled?.amount) !== paypal) return null;
  }
  return allocations;
}

async function refundedByTender(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: number, orderId: number): Promise<Record<RefundTender, number>> {
  const [credit, cash, paypal] = await Promise.all([
    tx.execute(sql`SELECT COALESCE(sum(amount),0)::numeric AS amount FROM customer_credit_ledger WHERE tenant_id=${tenantId} AND order_id=${orderId} AND entry_type='refund_restoration'`),
    tx.execute(sql`SELECT COALESCE(sum(abs(amount)),0)::numeric AS amount FROM cash_ledger_entries WHERE tenant_id=${tenantId} AND order_id=${orderId} AND entry_type='cash_refund'`),
    tx.execute(sql`SELECT COALESCE(sum(pr.amount),0)::numeric AS amount FROM payment_refunds pr JOIN payment_captures pc ON pc.tenant_id=pr.tenant_id AND pc.id=pr.payment_capture_id JOIN payment_attempts pa ON pa.tenant_id=pc.tenant_id AND pa.id=pc.payment_attempt_id WHERE pa.tenant_id=${tenantId} AND pa.order_id=${orderId} AND pr.state IN ('locally_finalized','completed')`),
  ]);
  return { customer_credit: cents(rows<Row>(credit)[0]?.amount), cash: cents(rows<Row>(cash)[0]?.amount), paypal: cents(rows<Row>(paypal)[0]?.amount) };
}

async function recordPostCloseoutCommissionAdjustment(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { tenantId: number; orderId: number; returnId: number },
): Promise<void> {
  const snapshot = rows<Row>(await tx.execute(sql`
    SELECT id,closeout_package_id AS "closeoutPackageId",shift_id AS "shiftId",csr_user_id AS "csrUserId",
      order_id AS "orderId",commission_basis::text AS basis,commission_rate::text AS rate,
      commission_amount::text AS "commissionAmount"
    FROM shift_commission_order_snapshots
    WHERE tenant_id=${input.tenantId} AND order_id=${input.orderId}
    FOR UPDATE
  `))[0];
  if (!snapshot) return; // There was no closed commission to reverse.
  const [refunds] = rows<Row>(await tx.execute(sql`
    SELECT COALESCE(sum(rl.unit_value),0)::text AS amount
    FROM return_lines rl
    JOIN return_transactions rt ON rt.tenant_id=${input.tenantId} AND rt.id=rl.return_transaction_id
    JOIN order_items oi ON oi.id=rl.order_item_id AND oi.order_id=${input.orderId}
    WHERE rt.tenant_id=${input.tenantId} AND rt.order_id=${input.orderId}
      AND rt.status='completed'
      AND oi.commission_eligibility_snapshot='eligible'
  `));
  const [basis] = rows<Row>(await tx.execute(sql`
    SELECT COALESCE(sum(commission_gross_amount - commission_discount_amount),0)::text AS amount
    FROM order_items
    WHERE order_id=${input.orderId} AND commission_eligibility_snapshot='eligible'
  `));
  let refundedAfterCloseout: string;
  try {
    refundedAfterCloseout = refundedCommissionBasisAfterCloseout({
      originalEligibleBasis: basis?.amount ?? "0.00",
      closeoutEligibleBasis: snapshot.basis,
      allCompletedRefundBasis: refunds?.amount ?? "0.00",
    });
  } catch {
    throw new PaymentServiceError(409, "COMMISSION_REFUND_RECONCILIATION_REQUIRED", "Completed refunds do not reconcile with the closed commission snapshot");
  }
  const [previous] = rows<Row>(await tx.execute(sql`
    SELECT COALESCE(sum(amount),0)::text AS amount FROM commission_refund_adjustments
    WHERE tenant_id=${input.tenantId} AND order_id=${input.orderId}
  `));
  const amount = calculatePostCloseoutCommissionRecovery({
    closeoutBasis: snapshot.basis,
    commissionRate: snapshot.rate,
    commissionPaid: snapshot.commissionAmount,
    eligibleRefundsSinceCloseout: refundedAfterCloseout,
    recoveryAlreadyRecorded: previous?.amount ?? "0.00",
  });
  if (amount === "0.00") return;
  await tx.execute(sql`
    INSERT INTO commission_refund_adjustments
      (tenant_id,original_closeout_package_id,original_shift_id,csr_user_id,order_id,return_id,amount,source_key)
    VALUES (${input.tenantId},${Number(snapshot.closeoutPackageId)},${Number(snapshot.shiftId)},${Number(snapshot.csrUserId)},${input.orderId},${input.returnId},${amount},${`return:${input.returnId}:post-closeout-commission`})
    ON CONFLICT (tenant_id,source_key) DO NOTHING
  `);
}

/** Local effects for a PayPal return happen only after the provider identity
 * has been committed.  This function is repeat-safe via the return status and
 * inventory movement idempotency keys. */
const finalizePayPalReturn = async (input: { returnId: number; tenantId: number; orderId: number; actor: { id: number; email: string | null; role: string }; ipAddress?: string }) => db.transaction(async tx => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId}, ${input.orderId})`);
  const ret = rows<Row>(await tx.execute(sql`SELECT * FROM return_transactions WHERE id=${input.returnId} AND tenant_id=${input.tenantId} FOR UPDATE`))[0];
  if (!ret) throw new Error("Return transaction not found");
  if (ret.status === "completed") return { idempotent: true };
  if (ret.status !== "pending") throw new Error("Return transaction is not pending provider finalization");
  const order = rows<Row>(await tx.execute(sql`SELECT * FROM orders WHERE tenant_id=${input.tenantId} AND id=${input.orderId} FOR UPDATE`))[0];
  if (!order) throw new Error("Order not found");
  const immutableTaxSnapshot = rows<Row>(await tx.execute(sql`SELECT snapshot_json FROM order_tax_snapshots WHERE tenant_id=${input.tenantId} AND order_id=${input.orderId} LIMIT 1`))[0]?.snapshot_json;
  if (!immutableTaxSnapshot || typeof immutableTaxSnapshot !== "object" || Array.isArray(immutableTaxSnapshot)) throw new PaymentServiceError(409, "REFUND_TAX_ALLOCATION_UNAVAILABLE", "Original tax snapshot requires manual reconciliation");
  const allocations = await resolveOriginalAllocations(tx, input.tenantId, order, immutableTaxSnapshot);
  if (!allocations) throw new PaymentServiceError(409, "REFUND_ALLOCATION_UNAVAILABLE", "Original payment allocation requires manual reconciliation");
  const lineTaxAllocations = storedLineTaxAllocations(immutableTaxSnapshot);
  if (!lineTaxAllocations) throw new PaymentServiceError(409, "REFUND_TAX_ALLOCATION_UNAVAILABLE", "Original line tax allocation requires manual reconciliation");
  const refunded = await refundedByTender(tx, input.tenantId, input.orderId);
  const currentProviderRefund = rows<Row>(await tx.execute(sql`SELECT pr.amount, pc.id AS capture_id, pc.amount AS capture_amount, pc.payment_attempt_id FROM payment_refunds pr JOIN payment_captures pc ON pc.tenant_id=pr.tenant_id AND pc.id=pr.payment_capture_id WHERE pr.tenant_id=${input.tenantId} AND pr.idempotency_key=${`return-paypal:${input.returnId}`} LIMIT 1`))[0];
  if (!currentProviderRefund) throw new PaymentServiceError(409, "REFUND_RECONCILIATION_REQUIRED", "PayPal refund intent is unavailable");
  const alreadyRefunded: Record<RefundTender, number> = { ...refunded, paypal: refunded.paypal - cents(currentProviderRefund?.amount) };
  if (alreadyRefunded.paypal < 0) throw new PaymentServiceError(409, "REFUND_RECONCILIATION_REQUIRED", "PayPal refund ledger is inconsistent");
  const cumulativeBefore = Object.values(alreadyRefunded).reduce((sum, amount) => sum + amount, 0);
  const proportional = allocateProportionalRefund({ cumulativeRefundCents: cumulativeBefore + cents(ret.refund_amount), original: allocations, alreadyRefunded });
  if (proportional.paypal !== cents(currentProviderRefund?.amount) || proportional.cash > 0) throw new PaymentServiceError(409, "REFUND_ALLOCATION_MISMATCH", "PayPal return allocation requires manual reconciliation");
  const creditRestorationCents = proportional.customer_credit;
  if (creditRestorationCents > 0) await restoreCustomerCredit(tx as never, {
    tenantId: input.tenantId,
    customerId: Number(order.customer_id),
    actorUserId: input.actor.id,
    orderId: input.orderId,
    amountCents: creditRestorationCents,
    idempotencyKey: `return-credit:${input.returnId}`,
    reason: `Refund/return ${input.returnId}`,
  });
  const lines = rows<Row>(await tx.execute(sql`SELECT rl.*, oi.catalog_item_id FROM return_lines rl JOIN order_items oi ON oi.id=rl.order_item_id WHERE rl.return_transaction_id=${input.returnId} ORDER BY rl.id`));
  for (const line of lines) {
    if (line.disposition !== "RESTOCK") continue;
    const sale = rows<Row>(await tx.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id=${input.tenantId} AND order_item_id=${Number(line.order_item_id)} AND movement_type='sale' ORDER BY id LIMIT 1`))[0];
    const valuation = rows<Row>(await tx.execute(sql`SELECT COALESCE(average_unit_cost, last_purchase_unit_cost) AS cost FROM inventory_valuation_states WHERE tenant_id=${input.tenantId} AND catalog_item_id=${Number(line.catalog_item_id)} LIMIT 1`))[0];
    await postInventoryMovement(tx as never, { tenantId: input.tenantId, actor: { id: input.actor.id, email: input.actor.email, role: input.actor.role, ipAddress: input.ipAddress }, entityType: "catalog", itemId: Number(line.catalog_item_id), locationId: Number(ret.location_id), movementType: "customer_return", quantity: String(line.quantity), unitCost: sale ? undefined : (valuation?.cost ? String(valuation.cost) : undefined), sourceType: "return", sourceId: sale ? String(sale.id) : `order-item:${line.order_item_id}`, orderId: input.orderId, orderItemId: Number(line.order_item_id), reasonCode: "customer_return_restock", reasonText: String(ret.reason), idempotencyKey: `return-movement:${input.returnId}:${line.order_item_id}` });
  }
  await tx.execute(sql`UPDATE return_transactions SET status='completed', updated_at=now() WHERE id=${input.returnId}`);
  await recordPostCloseoutCommissionAdjustment(tx, { tenantId: input.tenantId, orderId: input.orderId, returnId: input.returnId });
  const [taxLedger] = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(tax_amount),0)::numeric AS refunded FROM return_transactions WHERE tenant_id=${input.tenantId} AND order_id=${input.orderId} AND status='completed'`));
  const [taxSnapshot] = rows<Row>(await tx.execute(sql`SELECT tax_collected FROM order_tax_snapshots WHERE tenant_id=${input.tenantId} AND order_id=${input.orderId} LIMIT 1`));
  if (taxSnapshot && cents(taxLedger?.refunded) > cents(taxSnapshot.tax_collected)) throw new PaymentServiceError(409, "TAX_REFUND_LIMIT_EXCEEDED", "Refunded tax exceeds original tax collected");
  const afterRefund = await refundedByTender(tx, input.tenantId, input.orderId);
  const orderRefundedCents = Object.values(afterRefund).reduce((sum, amount) => sum + amount, 0);
  const paypalFull = afterRefund.paypal >= cents(currentProviderRefund.capture_amount);
  await tx.execute(sql`UPDATE payment_captures SET state=${paypalFull ? "refunded" : "partially_refunded"} WHERE tenant_id=${input.tenantId} AND id=${Number(currentProviderRefund.capture_id)}`);
  await tx.execute(sql`UPDATE payment_attempts SET state=${paypalFull ? "refunded" : "partially_refunded"} WHERE tenant_id=${input.tenantId} AND id=${Number(currentProviderRefund.payment_attempt_id)}`);
  await tx.execute(sql`UPDATE orders SET payment_status=${orderRefundedCents >= cents(order.total) ? "refunded" : "partially_refunded"}, status=CASE WHEN ${orderRefundedCents >= cents(order.total)} THEN 'refunded' ELSE status END WHERE tenant_id=${input.tenantId} AND id=${input.orderId}`);
  await tx.insert((await import("@workspace/db")).auditLogsTable).values({ tenantId: input.tenantId, actorId: input.actor.id, actorEmail: input.actor.email ?? "", actorRole: input.actor.role, action: "RETURN_COMPLETED", resourceType: "return_transaction", resourceId: String(input.returnId), metadata: { orderId: input.orderId, refundAmount: String(ret.refund_amount), taxAmount: String(ret.tax_amount), tenderType: "paypal", providerFinalized: true }, ipAddress: input.ipAddress ?? null });
  return { idempotent: false };
});

router.get("/orders/:id/returns", requirePermission("orders.refund"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) { res.status(422).json({ error: "Invalid order id" }); return; }
  const result = await db.execute(sql`
    SELECT rt.id, rt.status, rt.tender_type AS "tenderType", rt.refund_amount AS "refundAmount", rt.tax_amount AS "taxAmount", rt.reason, rt.actor_user_id AS "actorUserId", rt.created_at AS "createdAt",
      COALESCE(json_agg(json_build_object('orderItemId', rl.order_item_id, 'quantity', rl.quantity, 'disposition', rl.disposition)) FILTER (WHERE rl.id IS NOT NULL), '[]'::json) AS lines
    FROM return_transactions rt LEFT JOIN return_lines rl ON rl.return_transaction_id = rt.id
    WHERE rt.tenant_id = ${actor.tenantId!} AND rt.order_id = ${orderId}
    GROUP BY rt.id ORDER BY rt.created_at DESC
  `);
  res.json({ returns: rows(result) });
});

router.post("/orders/:id/returns", requirePermission("orders.refund"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const orderId = Number(req.params.id);
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!Number.isInteger(orderId) || orderId <= 0 || !parsed.success) { res.status(422).json({ error: "Invalid return request" }); return; }
  const tenantId = actor.tenantId!;
  const role = String(actor.role).toLowerCase();
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${orderId})`);
    const existing = rows<Row>(await tx.execute(sql`SELECT * FROM return_transactions WHERE tenant_id = ${tenantId} AND idempotency_key = ${parsed.data.idempotencyKey} LIMIT 1`))[0];
    if (existing && existing.status === "completed") return { status: 200, result: { id: Number(existing.id), status: existing.status, refundAmount: String(existing.refund_amount), taxAmount: String(existing.tax_amount), idempotent: true } };
    if (existing && existing.status === "pending" && existing.tender_type === "paypal") {
      const providerRefund = rows<Row>(await tx.execute(sql`SELECT amount FROM payment_refunds WHERE tenant_id=${tenantId} AND idempotency_key=${`return-paypal:${Number(existing.id)}`} LIMIT 1`))[0];
      if (!providerRefund) return { status: 409, error: "Return payment allocation requires reconciliation" };
      return { status: 202, paypalPending: { returnId: Number(existing.id), refundAmount: String(existing.refund_amount), paypalAmount: String(providerRefund.amount), creditRefundAmount: money(cents(existing.refund_amount) - cents(providerRefund.amount)), taxAmount: String(existing.tax_amount), reason: String(existing.reason) } };
    }
    const order = rows<Row>(await tx.execute(sql`
      SELECT o.*, COALESCE(ots.location_id, il.id) AS "locationId"
      FROM orders o LEFT JOIN order_tax_snapshots ots ON ots.tenant_id = o.tenant_id AND ots.order_id = o.id
      LEFT JOIN lab_tech_shifts ls ON ls.tenant_id = o.tenant_id AND ls.id = o.assigned_shift_id
      LEFT JOIN csr_boxes cb ON cb.tenant_id = o.tenant_id AND cb.slug = ls.box_assignment_id
      LEFT JOIN inventory_locations il ON il.tenant_id = o.tenant_id AND il.csr_box_id = cb.id AND il.is_active = true
      WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId} FOR UPDATE OF o
    `))[0];
    if (!order) return { status: 404, error: "Order not found" };
    if (!order.locationId) return { status: 409, error: "Order has no authoritative location" };
    if (role === "csr" && Number(order.assigned_csr_user_id ?? 0) !== actor.id) return { status: 403, error: "Order is outside the CSR location assignment" };
    if (!["paid", "partially_refunded"].includes(String(order.payment_status))) return { status: 409, error: "Only settled orders may be refunded" };
    const [taxSnapshot] = rows<Row>(await tx.execute(sql`SELECT snapshot_json, tax_collected FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${orderId} LIMIT 1`));
    const immutableTaxSnapshot = taxSnapshot?.snapshot_json;
    const allocations = await resolveOriginalAllocations(tx, tenantId, order, immutableTaxSnapshot);
    if (!allocations) return { status: 409, error: "Original payment allocation requires manual reconciliation" };
    const taxAllocations = storedLineTaxAllocations(immutableTaxSnapshot);
    if (!taxAllocations) return { status: 409, error: "Original line tax allocation requires manual reconciliation" };
    if (taxAllocations.reduce((sum, line) => sum + line.taxCents, 0) !== cents(order.tax)) return { status: 409, error: "Original line tax allocation does not match the order tax snapshot" };
    if (taxAllocations.reduce((sum, line) => sum + line.grossCents - line.discountCents, 0) !== cents(order.subtotal)) return { status: 409, error: "Original line merchandise allocation does not match the order snapshot" };
    const activeProviderRefund = rows<Row>(await tx.execute(sql`
      SELECT pr.id FROM payment_refunds pr
      JOIN payment_captures pc ON pc.tenant_id=pr.tenant_id AND pc.id=pr.payment_capture_id
      JOIN payment_attempts pa ON pa.tenant_id=pc.tenant_id AND pa.id=pc.payment_attempt_id
      WHERE pa.tenant_id=${tenantId} AND pa.order_id=${orderId}
        AND pr.state IN ('requested','pending','provider_succeeded','reconciliation_required') LIMIT 1
    `))[0];
    if (activeProviderRefund) return { status: 409, error: "A payment refund is awaiting provider reconciliation" };
    const otherPending = rows<Row>(await tx.execute(sql`SELECT id FROM return_transactions WHERE tenant_id=${tenantId} AND order_id=${orderId} AND status='pending' LIMIT 1`))[0];
    if (otherPending) return { status: 409, error: "Another return is awaiting payment reconciliation" };
    const priorTenderRefunds = await refundedByTender(tx, tenantId, orderId);
    const priorRefundedCents = Object.values(priorTenderRefunds).reduce((sum, amount) => sum + amount, 0);
    const originalPaidCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (priorRefundedCents >= originalPaidCents) return { status: 409, error: "Order is already fully refunded" };
    const [taxTotals] = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(rt.tax_amount) FILTER (WHERE rt.status='completed'),0)::numeric AS already_refunded FROM return_transactions rt WHERE rt.tenant_id=${tenantId} AND rt.order_id=${orderId}`));
    if (!taxSnapshot) return { status: 409, error: "Original tax snapshot requires manual reconciliation" };
    const itemMap = new Map<number, Row>();
    for (const line of rows<Row>(await tx.execute(sql`SELECT * FROM order_items WHERE order_id = ${orderId} FOR SHARE`))) itemMap.set(Number(line.id), line);
    let total = 0; let taxTotal = 0; const computed: Array<{ line: z.infer<typeof lineSchema>; item: Row; amount: number; tax: number; remaining: number }> = [];
    const requestedItemIds = new Set<number>();
    for (const line of parsed.data.lines) {
      if (requestedItemIds.has(line.orderItemId)) return { status: 422, error: "A return request may contain each order line only once" };
      requestedItemIds.add(line.orderItemId);
      const item = itemMap.get(line.orderItemId);
      if (!item) return { status: 422, error: "Return line is not part of this order" };
      const taxRecord = taxAllocations.find(record => record.orderItemId === line.orderItemId);
      if (!taxRecord || taxRecord.catalogItemId !== Number(item.catalog_item_id) || taxRecord.quantity !== Number(item.quantity)) return { status: 409, error: "Original line tax allocation requires manual reconciliation" };
      const already = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(rl.quantity),0)::int AS quantity, COALESCE(sum(rl.unit_value),0)::numeric AS amount, COALESCE(sum(rl.tax_value),0)::numeric AS tax FROM return_lines rl JOIN return_transactions rt ON rt.id = rl.return_transaction_id WHERE rt.tenant_id = ${tenantId} AND rt.order_id = ${orderId} AND rt.status = 'completed' AND rl.order_item_id = ${line.orderItemId}`))[0];
      const remaining = Number(item.quantity) - Number(already?.quantity ?? 0);
      if (line.quantity > remaining) return { status: 409, error: "Return quantity exceeds the remaining refundable quantity" };
      const priorQuantity = Number(already?.quantity ?? 0);
      const expectedPriorAmount = priorQuantity > 0 ? allocateCumulativeQuantityCents({ totalCents: taxRecord.grossCents - taxRecord.discountCents, totalQuantity: taxRecord.quantity, priorQuantity: 0, currentQuantity: priorQuantity }) : 0;
      const expectedPriorTax = priorQuantity > 0 ? allocateCumulativeQuantityCents({ totalCents: taxRecord.taxCents, totalQuantity: taxRecord.quantity, priorQuantity: 0, currentQuantity: priorQuantity }) : 0;
      if (priorQuantity > 0 && (cents(already?.amount) !== expectedPriorAmount || cents(already?.tax) !== expectedPriorTax)) return { status: 409, error: "Historical line refund amounts require manual reconciliation" };
      const amount = allocateCumulativeQuantityCents({ totalCents: taxRecord.grossCents - taxRecord.discountCents, totalQuantity: taxRecord.quantity, priorQuantity: Number(already?.quantity ?? 0), currentQuantity: line.quantity });
      const tax = allocateCumulativeQuantityCents({ totalCents: taxRecord.taxCents, totalQuantity: taxRecord.quantity, priorQuantity: Number(already?.quantity ?? 0), currentQuantity: line.quantity });
      if (taxRecord.taxableBaseCents === 0 && tax !== 0) return { status: 409, error: "Nontaxable line has an inconsistent tax snapshot" };
      if (taxRecord.taxableBaseCents > 0 && !taxRecord.taxable) return { status: 409, error: "Taxable line has an inconsistent tax snapshot" };
      total += amount + tax; taxTotal += tax; computed.push({ line, item, amount, tax, remaining });
    }
    if (total <= 0) return { status: 409, error: "Refund exceeds the authoritative refundable amount" };
    if (cents(taxTotals?.already_refunded) + taxTotal > cents(taxSnapshot.tax_collected)) return { status: 409, error: "Refunded tax exceeds original tax collected" };
    const cumulativeRefundCents = priorRefundedCents + total;
    let proportional: Record<RefundTender, number>;
    try { proportional = allocateProportionalRefund({ cumulativeRefundCents, original: allocations, alreadyRefunded: priorTenderRefunds }); }
    catch { return { status: 409, error: "Prior refunds conflict with the original proportional tender allocation" }; }
    if (proportional.cash > 0 && proportional.paypal > 0) return { status: 409, error: "Multiple external tender sources require manual reconciliation" };
    const creditRefundCents = proportional.customer_credit;
    const cashRefundCents = proportional.cash;
    const paypalRefundCents = proportional.paypal;
    const tenderType = paypalRefundCents > 0 ? "paypal" : cashRefundCents > 0 ? "cash" : "customer_credit";
    if (parsed.data.preview) return { status: 200, result: { preview: true, tenderType, refundAmount: money(total), taxAmount: money(taxTotal), creditRefundAmount: money(creditRefundCents), cashRefundAmount: money(cashRefundCents), paypalRefundAmount: money(paypalRefundCents), lines: computed.map(c => ({ orderItemId: c.line.orderItemId, quantity: c.line.quantity, disposition: c.line.disposition })) } };
    const paypalConfig = paypalRefundCents > 0 ? requireOnlinePayments(await loadTenantPaymentConfig(tenantId)) : null;
    const paypalService = paypalConfig ? new PaymentService(paypalConfig, new PayPalProvider(paypalConfig)) : undefined;
    const inserted = rows<Row>(await tx.execute(sql`
      INSERT INTO return_transactions (tenant_id, location_id, order_id, actor_user_id, status, tender_type, refund_amount, tax_amount, idempotency_key, reason)
      VALUES (${tenantId}, ${Number(order.locationId)}, ${orderId}, ${actor.id}, 'pending', ${tenderType}, ${money(total)}, ${money(taxTotal)}, ${parsed.data.idempotencyKey}, ${parsed.data.reason}) RETURNING id
    `))[0];
    if (!inserted) throw new Error("Return transaction could not be created");
    const returnId = Number(inserted.id);
    if (paypalService) {
      // Persist return lines and provider intent, then commit.  The PayPal POST
      // is intentionally outside this transaction so a local rollback cannot
      // erase the stable PayPal-Request-Id.
      for (const c of computed) await tx.execute(sql`INSERT INTO return_lines (return_transaction_id, order_item_id, quantity, unit_value, tax_value, disposition) VALUES (${returnId}, ${c.line.orderItemId}, ${c.line.quantity}, ${money(c.amount)}, ${money(c.tax)}, ${c.line.disposition})`);
      const intent = await paypalService.prepareRefundInTransaction(tx, { tenantId, orderId, actorUserId: actor.id, idempotencyKey: `return-paypal:${returnId}`, returnId, amount: money(paypalRefundCents), reason: parsed.data.reason });
      return { status: 202, paypalPending: { returnId, refundAmount: money(total), paypalAmount: money(paypalRefundCents), creditRefundAmount: money(creditRefundCents), taxAmount: money(taxTotal), reason: parsed.data.reason, intent } };
    }
    if (creditRefundCents > 0) {
      await restoreCustomerCredit(tx as never, { tenantId, customerId: Number(order.customer_id), actorUserId: actor.id, orderId, amountCents: creditRefundCents, idempotencyKey: `return-credit:${returnId}`, reason: `Refund/return ${returnId}` });
    }
    if (cashRefundCents > 0) {
      const shift = rows<Row>(await tx.execute(sql`SELECT id, tech_id, box_assignment_id, status FROM lab_tech_shifts WHERE tenant_id = ${tenantId} AND id = ${order.assigned_shift_id ?? 0} LIMIT 1`))[0];
      if (!shift || shift.status !== "active") return { status: 409, error: "An active accountable cash session is required for cash refunds" };
      await tx.execute(sql`
        INSERT INTO cash_ledger_entries (tenant_id, order_id, shift_id, csr_user_id, actor_user_id, location_id, box_assignment_id, amount, amount_tendered, change_given, internal_note, entry_type, idempotency_key)
        VALUES (${tenantId}, ${orderId}, ${Number(shift.id)}, ${Number(shift.tech_id)}, ${actor.id}, ${Number(order.locationId)}, ${String(shift.box_assignment_id)}, ${money(cashRefundCents)}, '0.00', '0.00', ${parsed.data.reason}, 'cash_refund', ${`return-cash:${returnId}`})
      `);
    }
    for (const c of computed) {
      const [line] = rows<Row>(await tx.execute(sql`INSERT INTO return_lines (return_transaction_id, order_item_id, quantity, unit_value, tax_value, disposition) VALUES (${returnId}, ${c.line.orderItemId}, ${c.line.quantity}, ${money(c.amount)}, ${money(c.tax)}, ${c.line.disposition}) RETURNING id`));
      if (c.line.disposition === "RESTOCK") {
        const sale = rows<Row>(await tx.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_item_id = ${c.line.orderItemId} AND movement_type = 'sale' ORDER BY id LIMIT 1`))[0];
        const valuation = rows<Row>(await tx.execute(sql`SELECT COALESCE(average_unit_cost, last_purchase_unit_cost) AS cost FROM inventory_valuation_states WHERE tenant_id = ${tenantId} AND catalog_item_id = ${Number(c.item.catalog_item_id)} LIMIT 1`))[0];
        await postInventoryMovement(tx as never, { tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "catalog", itemId: Number(c.item.catalog_item_id), locationId: Number(order.locationId), movementType: "customer_return", quantity: String(c.line.quantity), unitCost: sale ? undefined : (valuation?.cost ? String(valuation.cost) : undefined), sourceType: "return", sourceId: sale ? String(sale.id) : `order-item:${c.line.orderItemId}`, orderId, orderItemId: c.line.orderItemId, reasonCode: "customer_return_restock", reasonText: parsed.data.reason, idempotencyKey: `return-movement:${returnId}:${c.line.orderItemId}` });
      }
      await tx.insert((await import("@workspace/db")).auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "RETURN_LINE_COMPLETED", resourceType: "return_line", resourceId: String(line.id), metadata: { orderId, orderItemId: c.line.orderItemId, quantity: c.line.quantity, disposition: c.line.disposition, returnId }, ipAddress: req.ip ?? null });
    }
    const full = priorRefundedCents + total >= originalPaidCents;
    await tx.execute(sql`UPDATE orders SET payment_status = ${full ? "refunded" : "partially_refunded"}, status = CASE WHEN ${full} THEN 'refunded' ELSE status END, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${orderId}`);
    await tx.execute(sql`UPDATE return_transactions SET status = 'completed', updated_at = now() WHERE id = ${returnId}`);
    await recordPostCloseoutCommissionAdjustment(tx, { tenantId, orderId, returnId });
    // order_tax_snapshots is immutable by database trigger. Completed return
    // transactions are the append-only tax-refund ledger; never rewrite the
    // original tax snapshot to report cumulative refunds.
    await tx.insert((await import("@workspace/db")).auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "RETURN_COMPLETED", resourceType: "return_transaction", resourceId: String(returnId), metadata: { orderId, refundAmount: money(total), taxAmount: money(taxTotal), tenderType, reason: parsed.data.reason }, ipAddress: req.ip ?? null });
    return { status: 200, result: { id: returnId, status: "completed", refundAmount: money(total), taxAmount: money(taxTotal), creditRefundAmount: money(creditRefundCents), cashRefundAmount: money(cashRefundCents), paypalRefundAmount: money(paypalRefundCents), tenderType, idempotent: false } };
  });
  if ("paypalPending" in outcome) {
    const pending = outcome.paypalPending;
    if (!pending) { res.status(500).json({ error: "Invalid return outcome" }); return; }
    const paypalConfig = requireOnlinePayments(await loadTenantPaymentConfig(tenantId));
    const paypalService = new PaymentService(paypalConfig, new PayPalProvider(paypalConfig));
    try {
      // Re-entering with the same return idempotency key reuses the durable
      // provider request ID and therefore cannot create a second refund.
      const providerResult = await paypalService.refund({ tenantId, orderId, actorUserId: actor.id, idempotencyKey: `return-paypal:${pending.returnId}`, returnId: pending.returnId, amount: pending.paypalAmount, reason: pending.reason });
      if (providerResult.status !== "completed") { res.status(502).json({ error: "PayPal refund requires reconciliation", returnId: pending.returnId }); return; }
      const local = await finalizePayPalReturn({ returnId: pending.returnId, tenantId, orderId, actor, ipAddress: req.ip });
      res.status(200).json({ id: pending.returnId, status: "completed", refundAmount: pending.refundAmount, taxAmount: pending.taxAmount, creditRefundAmount: pending.creditRefundAmount, paypalRefundAmount: pending.paypalAmount, tenderType: "paypal", idempotent: providerResult.replayed && local.idempotent });
      return;
    } catch (error) {
      res.status(error instanceof PaymentServiceError ? error.statusCode : 502).json({ error: error instanceof Error ? error.message : "PayPal refund failed", returnId: pending.returnId });
      return;
    }
  }
  if ("error" in outcome) { res.status(outcome.status).json({ error: outcome.error }); return; }
  res.status(outcome.status).json(outcome.result);
});

export default router;
