import { formatMoneyCents, requiredNonNegativeMoneyCents } from "./shiftCloseoutFinancials";

export type CommissionEligibility = "eligible" | "membership" | "excluded" | "unclassified";
export type ShiftEarningOrder = {
  orderId: number;
  routeSource: string | null;
  paymentStatus: string;
  deliveryMethod: string | null;
  fulfillmentStatus?: string | null;
  uberRequestState?: string | null;
  uberProviderDeliveryId?: string | null;
  uberProviderStatus?: string | null;
  deliveryFee: unknown;
  tipAmount: unknown;
  lines: Array<{
    orderItemId: number;
    eligibility: CommissionEligibility;
    grossAmount: unknown;
    discountAmount: unknown;
    refundedAmount: unknown;
  }>;
};

export type ShiftEarningLine = {
  kind: "customer_tip" | "csr_delivery" | "house_delivery" | "uber_provider_delivery";
  amount: string;
  sourceKey: string;
  sourceOrderId: number;
  metadata: Record<string, unknown>;
};

export function calculateShiftEarnings(orders: ShiftEarningOrder[], commissionPercent: 15 | 16 | 17 | 18) {
  let commissionBasis = 0n;
  let customerTips = 0n;
  let csrDelivery = 0n;
  let houseDelivery = 0n;
  let uberProviderDelivery = 0n;
  const lines: ShiftEarningLine[] = [];
  const orderCommissionBases = new Map<number, bigint>();

  for (const order of orders) {
    const commissionEligibleOrder = ["paid", "partially_refunded"].includes(order.paymentStatus)
      && order.routeSource !== "general_account" && order.routeSource !== "general_queue";
    if (commissionEligibleOrder) {
      for (const item of order.lines) {
        if (item.eligibility !== "eligible") continue;
        const gross = requiredNonNegativeMoneyCents(item.grossAmount, `orderItem.${item.orderItemId}.commissionGrossAmount`);
        const discount = requiredNonNegativeMoneyCents(item.discountAmount, `orderItem.${item.orderItemId}.commissionDiscountAmount`);
        const refunded = requiredNonNegativeMoneyCents(item.refundedAmount, `orderItem.${item.orderItemId}.refundedAmount`);
        if (discount > gross || refunded > gross - discount) throw new Error("Commission snapshot/refund exceeds discounted product sale");
        commissionBasis += gross - discount - refunded;
        orderCommissionBases.set(order.orderId, (orderCommissionBases.get(order.orderId) ?? 0n) + gross - discount - refunded);
      }
    }

    const financiallySettled = ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus);
    const tip = financiallySettled ? requiredNonNegativeMoneyCents(order.tipAmount, `order.${order.orderId}.tipAmount`) : 0n;
    if (tip > 0n) {
      customerTips += tip;
      lines.push({ kind: "customer_tip", amount: formatMoneyCents(tip), sourceKey: `order:${order.orderId}:customer_tip`, sourceOrderId: order.orderId, metadata: { recipientShare: "1.000000" } });
    }
    const fee = requiredNonNegativeMoneyCents(order.deliveryFee ?? "0", `order.${order.orderId}.deliveryFee`);
    const deliveryCompleted = ["completed", "delivered"].includes(order.fulfillmentStatus ?? "");
    if (order.deliveryMethod === "csr_delivery" && deliveryCompleted && fee > 0n) {
      const csr = (fee * 80n + 50n) / 100n;
      const house = fee - csr;
      csrDelivery += csr; houseDelivery += house;
      lines.push({ kind: "csr_delivery", amount: formatMoneyCents(csr), sourceKey: `order:${order.orderId}:csr_delivery`, sourceOrderId: order.orderId, metadata: { quotedFee: formatMoneyCents(fee), share: "0.800000" } });
      lines.push({ kind: "house_delivery", amount: formatMoneyCents(house), sourceKey: `order:${order.orderId}:house_delivery`, sourceOrderId: order.orderId, metadata: { quotedFee: formatMoneyCents(fee), share: "0.200000" } });
    } else if (order.deliveryMethod === "uber_direct" && uberDeliveryIsFinanciallyCommitted(order) && fee > 0n) {
      uberProviderDelivery += fee;
      lines.push({ kind: "uber_provider_delivery", amount: formatMoneyCents(fee), sourceKey: `order:${order.orderId}:uber_provider_delivery`, sourceOrderId: order.orderId, metadata: { provider: "uber_direct", share: "1.000000" } });
    }
  }

  const commissionRate = (commissionPercent / 100).toFixed(6);
  const commission = (commissionBasis * BigInt(commissionPercent) + 50n) / 100n;
  const orderAllocations = [...orderCommissionBases.entries()].map(([orderId, basis]) => {
    const numerator = basis * BigInt(commissionPercent);
    return { orderId, basis, amount: numerator / 100n, remainder: numerator % 100n };
  });
  let unallocatedCommission = commission - orderAllocations.reduce((sum, item) => sum + item.amount, 0n);
  for (const allocation of [...orderAllocations].sort((a, b) => a.remainder === b.remainder
    ? a.orderId - b.orderId
    : a.remainder > b.remainder ? -1 : 1)) {
    if (unallocatedCommission <= 0n) break;
    allocation.amount += 1n;
    unallocatedCommission -= 1n;
  }
  if (unallocatedCommission !== 0n) throw new Error("Order commission allocation does not reconcile to the shift total");
  const orderCommissions = orderAllocations.map(({ orderId, basis, amount }) => ({
    orderId, commissionBasis: formatMoneyCents(basis), commissionRate,
    commissionAmount: formatMoneyCents(amount),
  }));
  return {
    commissionBasis: formatMoneyCents(commissionBasis),
    commissionAmount: formatMoneyCents(commission),
    orderCommissions,
    customerTips: formatMoneyCents(customerTips),
    csrDeliveryEarnings: formatMoneyCents(csrDelivery),
    houseDeliveryShare: formatMoneyCents(houseDelivery),
    uberProviderDelivery: formatMoneyCents(uberProviderDelivery),
    csrPayout: formatMoneyCents(commission + customerTips + csrDelivery),
    lines,
  };
}

export function calculatePostCloseoutCommissionRecovery(input: {
  closeoutBasis: unknown;
  commissionRate: unknown;
  commissionPaid: unknown;
  eligibleRefundsSinceCloseout: unknown;
  recoveryAlreadyRecorded: unknown;
}): string {
  const basis = requiredNonNegativeMoneyCents(input.closeoutBasis, "closeoutBasis");
  const paid = requiredNonNegativeMoneyCents(input.commissionPaid, "commissionPaid");
  const refunded = requiredNonNegativeMoneyCents(input.eligibleRefundsSinceCloseout, "eligibleRefundsSinceCloseout");
  const alreadyRecorded = requiredNonNegativeMoneyCents(input.recoveryAlreadyRecorded, "recoveryAlreadyRecorded");
  if (refunded > basis) throw new Error("Refunded commission basis exceeds the closed order snapshot");
  if (typeof input.commissionRate !== "string" || !/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(input.commissionRate)) {
    throw new Error("Commission rate snapshot is invalid");
  }
  const [whole, fraction = ""] = input.commissionRate.split(".");
  const rateMicros = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  const remainingBasis = basis - refunded;
  const commissionStillEarned = (remainingBasis * rateMicros + 500_000n) / 1_000_000n;
  const targetRecovery = paid - commissionStillEarned;
  if (targetRecovery < 0n || alreadyRecorded > targetRecovery) throw new Error("Post-closeout commission recovery is inconsistent");
  return formatMoneyCents(targetRecovery - alreadyRecorded);
}

/** Derive post-closeout refunds from immutable basis, not wall-clock timestamps. */
export function refundedCommissionBasisAfterCloseout(input: {
  originalEligibleBasis: unknown;
  closeoutEligibleBasis: unknown;
  allCompletedRefundBasis: unknown;
}): string {
  const original = requiredNonNegativeMoneyCents(input.originalEligibleBasis, "originalEligibleBasis");
  const closed = requiredNonNegativeMoneyCents(input.closeoutEligibleBasis, "closeoutEligibleBasis");
  const refunded = requiredNonNegativeMoneyCents(input.allCompletedRefundBasis, "allCompletedRefundBasis");
  if (closed > original) throw new Error("Closed commission basis exceeds the original eligible basis");
  const priorRefunds = original - closed;
  if (refunded < priorRefunds) throw new Error("Completed refunds do not reconcile with the closed commission basis");
  return formatMoneyCents(refunded - priorRefunds);
}

function uberDeliveryIsFinanciallyCommitted(order: ShiftEarningOrder): boolean {
  if (order.uberProviderDeliveryId) return true;
  return ["creating", "reconciliation_required", "manual_reconciliation_required", "canceling", "cancel_reconciliation_required"]
    .includes(order.uberRequestState ?? "");
}
