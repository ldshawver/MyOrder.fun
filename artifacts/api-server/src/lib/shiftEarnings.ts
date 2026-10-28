import { formatMoneyCents, requiredNonNegativeMoneyCents } from "./shiftCloseoutFinancials";

export type CommissionEligibility = "eligible" | "membership" | "excluded" | "unclassified";
export type ShiftEarningOrder = {
  orderId: number;
  routeSource: string | null;
  paymentStatus: string;
  deliveryMethod: string | null;
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

  for (const order of orders) {
    if (!["paid", "partially_refunded"].includes(order.paymentStatus) || order.routeSource === "general_account" || order.routeSource === "general_queue") continue;
    for (const item of order.lines) {
      if (item.eligibility !== "eligible") continue;
      const gross = requiredNonNegativeMoneyCents(item.grossAmount, `orderItem.${item.orderItemId}.commissionGrossAmount`);
      const discount = requiredNonNegativeMoneyCents(item.discountAmount, `orderItem.${item.orderItemId}.commissionDiscountAmount`);
      const refunded = requiredNonNegativeMoneyCents(item.refundedAmount, `orderItem.${item.orderItemId}.refundedAmount`);
      if (discount > gross || refunded > gross - discount) throw new Error("Commission snapshot/refund exceeds discounted product sale");
      commissionBasis += gross - discount - refunded;
    }

    const tip = requiredNonNegativeMoneyCents(order.tipAmount, `order.${order.orderId}.tipAmount`);
    if (tip > 0n) {
      customerTips += tip;
      lines.push({ kind: "customer_tip", amount: formatMoneyCents(tip), sourceKey: `order:${order.orderId}:customer_tip`, sourceOrderId: order.orderId, metadata: { recipientShare: "1.000000" } });
    }
    const fee = requiredNonNegativeMoneyCents(order.deliveryFee ?? "0", `order.${order.orderId}.deliveryFee`);
    if (order.deliveryMethod === "csr_delivery" && fee > 0n) {
      const csr = (fee * 80n + 50n) / 100n;
      const house = fee - csr;
      csrDelivery += csr; houseDelivery += house;
      lines.push({ kind: "csr_delivery", amount: formatMoneyCents(csr), sourceKey: `order:${order.orderId}:csr_delivery`, sourceOrderId: order.orderId, metadata: { quotedFee: formatMoneyCents(fee), share: "0.800000" } });
      lines.push({ kind: "house_delivery", amount: formatMoneyCents(house), sourceKey: `order:${order.orderId}:house_delivery`, sourceOrderId: order.orderId, metadata: { quotedFee: formatMoneyCents(fee), share: "0.200000" } });
    } else if (order.deliveryMethod === "uber_direct" && fee > 0n) {
      uberProviderDelivery += fee;
      lines.push({ kind: "uber_provider_delivery", amount: formatMoneyCents(fee), sourceKey: `order:${order.orderId}:uber_provider_delivery`, sourceOrderId: order.orderId, metadata: { provider: "uber_direct", share: "1.000000" } });
    }
  }

  const commission = (commissionBasis * BigInt(commissionPercent) + 50n) / 100n;
  return {
    commissionBasis: formatMoneyCents(commissionBasis),
    commissionAmount: formatMoneyCents(commission),
    customerTips: formatMoneyCents(customerTips),
    csrDeliveryEarnings: formatMoneyCents(csrDelivery),
    houseDeliveryShare: formatMoneyCents(houseDelivery),
    uberProviderDelivery: formatMoneyCents(uberProviderDelivery),
    csrPayout: formatMoneyCents(commission + customerTips + csrDelivery),
    lines,
  };
}
