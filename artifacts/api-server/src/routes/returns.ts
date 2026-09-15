import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { z } from "zod";
import { postInventoryMovement } from "../lib/inventoryMovementLedger";
import { restoreCustomerCredit } from "../payments/customerCredit";
import { loadPaymentConfig, requireOnlinePayments } from "../payments/config";
import { PayPalProvider } from "../payments/paypal";
import { PaymentService, PaymentServiceError } from "../payments/service";

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
  const lines = rows<Row>(await tx.execute(sql`SELECT rl.*, oi.catalog_item_id FROM return_lines rl JOIN order_items oi ON oi.id=rl.order_item_id WHERE rl.return_transaction_id=${input.returnId} ORDER BY rl.id`));
  for (const line of lines) {
    if (line.disposition !== "RESTOCK") continue;
    const sale = rows<Row>(await tx.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id=${input.tenantId} AND order_item_id=${Number(line.order_item_id)} AND movement_type='sale' ORDER BY id LIMIT 1`))[0];
    const valuation = rows<Row>(await tx.execute(sql`SELECT COALESCE(average_unit_cost, last_purchase_unit_cost) AS cost FROM inventory_valuation_states WHERE tenant_id=${input.tenantId} AND catalog_item_id=${Number(line.catalog_item_id)} LIMIT 1`))[0];
    await postInventoryMovement(tx as never, { tenantId: input.tenantId, actor: { id: input.actor.id, email: input.actor.email, role: input.actor.role, ipAddress: input.ipAddress }, entityType: "catalog", itemId: Number(line.catalog_item_id), locationId: Number(ret.location_id), movementType: "customer_return", quantity: String(line.quantity), unitCost: sale ? undefined : (valuation?.cost ? String(valuation.cost) : undefined), sourceType: "return", sourceId: sale ? String(sale.id) : `order-item:${line.order_item_id}`, orderId: input.orderId, orderItemId: Number(line.order_item_id), reasonCode: "customer_return_restock", reasonText: String(ret.reason), idempotencyKey: `return-movement:${input.returnId}:${line.order_item_id}` });
  }
  await tx.execute(sql`UPDATE return_transactions SET status='completed', updated_at=now() WHERE id=${input.returnId}`);
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
    if (existing && existing.status === "pending" && existing.tender_type === "paypal") return { status: 202, paypalPending: { returnId: Number(existing.id), refundAmount: String(existing.refund_amount), taxAmount: String(existing.tax_amount), reason: String(existing.reason) } };
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
    const tender = String(order.selected_payment_method ?? order.payment_method ?? "").toLowerCase();
    const tenderType = tender.includes("customer_credit") || tender === "comp" ? "customer_credit" : tender === "cash" ? "cash" : tender.startsWith("paypal") ? "paypal" : null;
    if (!tenderType) return { status: 409, error: "Unsupported refund tender" };
    const paypalService = tenderType === "paypal"
      ? new PaymentService(requireOnlinePayments(loadPaymentConfig()), new PayPalProvider(requireOnlinePayments(loadPaymentConfig())))
      : undefined;
    const paidCents = tenderType === "customer_credit" ? cents(order.customer_credit_applied) : cents(order.total);
    const prior = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(refund_amount),0) AS amount FROM return_transactions WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND status = 'completed'`))[0];
    const remainingPaid = paidCents - cents(prior?.amount);
    if (remainingPaid <= 0) return { status: 409, error: "Order is already fully refunded" };
    const itemMap = new Map<number, Row>();
    for (const line of rows<Row>(await tx.execute(sql`SELECT * FROM order_items WHERE order_id = ${orderId} FOR SHARE`))) itemMap.set(Number(line.id), line);
    let total = 0; let taxTotal = 0; const computed: Array<{ line: z.infer<typeof lineSchema>; item: Row; amount: number; tax: number; remaining: number }> = [];
    for (const line of parsed.data.lines) {
      const item = itemMap.get(line.orderItemId);
      if (!item) return { status: 422, error: "Return line is not part of this order" };
      const already = rows<Row>(await tx.execute(sql`SELECT COALESCE(sum(rl.quantity),0) AS quantity FROM return_lines rl JOIN return_transactions rt ON rt.id = rl.return_transaction_id WHERE rt.tenant_id = ${tenantId} AND rt.order_id = ${orderId} AND rt.status = 'completed' AND rl.order_item_id = ${line.orderItemId}`))[0];
      const remaining = Number(item.quantity) - Number(already?.quantity ?? 0);
      if (line.quantity > remaining) return { status: 409, error: "Return quantity exceeds the remaining refundable quantity" };
      const amount = cents(item.unit_price) * line.quantity;
      const tax = cents(order.subtotal) > 0 ? Math.round(cents(order.tax) * amount / cents(order.subtotal)) : 0;
      total += amount + tax; taxTotal += tax; computed.push({ line, item, amount, tax, remaining });
    }
    if (total <= 0) return { status: 409, error: "Refund exceeds the authoritative refundable amount" };
    // Allocate the final cent of tax to the final eligible return rather than
    // rounding each partial line upward. This preserves the immutable paid
    // total while allowing a valid second return for the remaining quantity.
    if (total > remainingPaid) {
      const allRequestedRemainder = computed.every((c) => c.line.quantity === c.remaining);
      const roundingOverage = total - remainingPaid;
      if (!allRequestedRemainder || roundingOverage > 1) return { status: 409, error: "Refund exceeds the authoritative refundable amount" };
      total = remainingPaid;
      taxTotal = Math.max(0, taxTotal - roundingOverage);
      const last = computed[computed.length - 1];
      if (last) last.tax = Math.max(0, last.tax - roundingOverage);
    }
    if (parsed.data.preview) return { status: 200, result: { preview: true, tenderType, refundAmount: money(total), taxAmount: money(taxTotal), lines: computed.map(c => ({ orderItemId: c.line.orderItemId, quantity: c.line.quantity, disposition: c.line.disposition })) } };
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
      const intent = await paypalService.prepareRefundInTransaction(tx, { tenantId, orderId, actorUserId: actor.id, idempotencyKey: `return-paypal:${returnId}`, amount: money(total), reason: parsed.data.reason });
      return { status: 202, paypalPending: { returnId, refundAmount: money(total), taxAmount: money(taxTotal), reason: parsed.data.reason, intent } };
    }
    if (tenderType === "customer_credit") {
      await restoreCustomerCredit(tx as never, { tenantId, customerId: Number(order.customer_id), actorUserId: actor.id, orderId, amountCents: total, idempotencyKey: `return-credit:${returnId}`, reason: `Refund/return ${returnId}` });
    } else {
      const shift = rows<Row>(await tx.execute(sql`SELECT id, tech_id, box_assignment_id, status FROM lab_tech_shifts WHERE tenant_id = ${tenantId} AND id = ${order.assigned_shift_id ?? 0} LIMIT 1`))[0];
      if (!shift || shift.status !== "active") return { status: 409, error: "An active accountable cash session is required for cash refunds" };
      await tx.execute(sql`
        INSERT INTO cash_ledger_entries (tenant_id, order_id, shift_id, csr_user_id, actor_user_id, location_id, box_assignment_id, amount, amount_tendered, change_given, internal_note, entry_type, idempotency_key)
        VALUES (${tenantId}, ${orderId}, ${Number(shift.id)}, ${Number(shift.tech_id)}, ${actor.id}, ${Number(order.locationId)}, ${String(shift.box_assignment_id)}, ${money(total)}, '0.00', '0.00', ${parsed.data.reason}, 'cash_refund', ${`return-cash:${returnId}`})
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
    const full = total >= remainingPaid;
    await tx.execute(sql`UPDATE orders SET payment_status = ${full ? "refunded" : "partially_refunded"}, status = CASE WHEN ${full} THEN 'refunded' ELSE status END, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${orderId}`);
    await tx.execute(sql`UPDATE return_transactions SET status = 'completed', updated_at = now() WHERE id = ${returnId}`);
    await tx.insert((await import("@workspace/db")).auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "RETURN_COMPLETED", resourceType: "return_transaction", resourceId: String(returnId), metadata: { orderId, refundAmount: money(total), taxAmount: money(taxTotal), tenderType, reason: parsed.data.reason }, ipAddress: req.ip ?? null });
    return { status: 200, result: { id: returnId, status: "completed", refundAmount: money(total), taxAmount: money(taxTotal), tenderType, idempotent: false } };
  });
  if ("paypalPending" in outcome) {
    const pending = outcome.paypalPending;
    if (!pending) { res.status(500).json({ error: "Invalid return outcome" }); return; }
    const paypalService = new PaymentService(requireOnlinePayments(loadPaymentConfig()), new PayPalProvider(requireOnlinePayments(loadPaymentConfig())));
    try {
      // Re-entering with the same return idempotency key reuses the durable
      // provider request ID and therefore cannot create a second refund.
      const providerResult = await paypalService.refund({ tenantId, orderId, actorUserId: actor.id, idempotencyKey: `return-paypal:${pending.returnId}`, amount: pending.refundAmount, reason: pending.reason });
      if (providerResult.status !== "completed") { res.status(502).json({ error: "PayPal refund requires reconciliation", returnId: pending.returnId }); return; }
      const local = await finalizePayPalReturn({ returnId: pending.returnId, tenantId, orderId, actor, ipAddress: req.ip });
      res.status(200).json({ id: pending.returnId, status: "completed", refundAmount: pending.refundAmount, taxAmount: pending.taxAmount, tenderType: "paypal", idempotent: providerResult.replayed && local.idempotent });
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
