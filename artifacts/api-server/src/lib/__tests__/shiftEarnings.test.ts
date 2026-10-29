import { describe, expect, it } from "vitest";
import { calculatePostCloseoutCommissionRecovery, calculateShiftEarnings, refundedCommissionBasisAfterCloseout, type ShiftEarningOrder } from "../shiftEarnings";
import { ShiftCloseoutSerializationError, withSerializableRetry } from "../shiftCloseoutFinancials";

const order = (patch: Partial<ShiftEarningOrder> = {}): ShiftEarningOrder => ({
  orderId: 1, routeSource: "active_csr", paymentStatus: "paid", deliveryMethod: "pickup", deliveryFee: "0.00", tipAmount: "0.00",
  lines: [{ orderItemId: 10, eligibility: "eligible", grossAmount: "100.00", discountAmount: "20.00", refundedAmount: "0.00" }], ...patch,
});

describe("shift earnings", () => {
  it("calculates commission from discounted eligible product sales", () => {
    expect(calculateShiftEarnings([order()], 15)).toMatchObject({ commissionBasis: "80.00", commissionAmount: "12.00", customerTips: "0.00" });
  });
  it("allocates cent rounding per order without changing the established shift total", () => {
    const orders = [order({ orderId: 2, lines: [{ orderItemId: 20, eligibility: "eligible", grossAmount: "0.03", discountAmount: "0.00", refundedAmount: "0.00" }] }),
      order({ orderId: 1, lines: [{ orderItemId: 10, eligibility: "eligible", grossAmount: "0.03", discountAmount: "0.00", refundedAmount: "0.00" }] })];
    const result = calculateShiftEarnings(orders, 15);
    expect(result.commissionAmount).toBe("0.01");
    expect(result.orderCommissions.reduce((sum, item) => sum + Math.round(Number(item.commissionAmount) * 100), 0)).toBe(1);
    expect(result.orderCommissions.find(item => item.orderId === 1)?.commissionAmount).toBe("0.01");
  });
  it("excludes memberships, explicitly excluded, unclassified, and General Queue sales", () => {
    const excluded = ["membership", "excluded", "unclassified"].map((eligibility, i) => order({ orderId: i + 1, lines: [{ ...order().lines[0]!, eligibility: eligibility as never }] }));
    expect(calculateShiftEarnings([...excluded, order({ orderId: 9, routeSource: "general_account" })], 18).commissionBasis).toBe("0.00");
  });
  it("keeps tips and CSR 80/20 delivery separate", () => {
    expect(calculateShiftEarnings([order({ deliveryMethod: "csr_delivery", fulfillmentStatus: "completed", deliveryFee: "10.01", tipAmount: "7.25" })], 15)).toMatchObject({ customerTips: "7.25", csrDeliveryEarnings: "8.01", houseDeliveryShare: "2.00", csrPayout: "27.26" });
  });
  it("credits the full quoted Uber fee to the provider and none to the CSR", () => {
    expect(calculateShiftEarnings([order({ deliveryMethod: "uber_direct", uberProviderDeliveryId: "delivery-1", deliveryFee: "14.30" })], 15)).toMatchObject({ uberProviderDelivery: "14.30", csrDeliveryEarnings: "0.00", houseDeliveryShare: "0.00" });
  });
  it("reduces commission basis for line refunds without changing the actual tip", () => {
    expect(calculateShiftEarnings([order({ paymentStatus: "partially_refunded", tipAmount: "5.00", lines: [{ ...order().lines[0]!, refundedAmount: "30.00" }] })], 16)).toMatchObject({ commissionBasis: "50.00", commissionAmount: "8.00", customerTips: "5.00" });
    expect(calculateShiftEarnings([order({ paymentStatus: "refunded", deliveryMethod: "uber_direct", uberRequestState: "delivery_created", uberProviderDeliveryId: "delivery-2", deliveryFee: "12.00", tipAmount: "5.00" })], 16)).toMatchObject({ commissionBasis: "0.00", commissionAmount: "0.00", customerTips: "5.00", uberProviderDelivery: "12.00" });
  });
  it("excludes General Queue commission without suppressing settled tips or Uber provider liability", () => {
    expect(calculateShiftEarnings([order({ routeSource: "general_account", deliveryMethod: "uber_direct", uberRequestState: "reconciliation_required", deliveryFee: "9.00", tipAmount: "3.00" })], 15)).toMatchObject({ commissionBasis: "0.00", commissionAmount: "0.00", customerTips: "3.00", uberProviderDelivery: "9.00" });
  });
  it("recognizes CSR delivery shares only after fulfillment completes", () => {
    expect(calculateShiftEarnings([order({ deliveryMethod: "csr_delivery", fulfillmentStatus: "ready", deliveryFee: "10.00" })], 15)).toMatchObject({ csrDeliveryEarnings: "0.00", houseDeliveryShare: "0.00" });
  });
  it("computes only the incremental post-closeout refund commission recovery", () => {
    expect(calculatePostCloseoutCommissionRecovery({ closeoutBasis: "100.00", commissionRate: "0.150000", commissionPaid: "15.00", eligibleRefundsSinceCloseout: "20.00", recoveryAlreadyRecorded: "0.00" })).toBe("3.00");
    expect(calculatePostCloseoutCommissionRecovery({ closeoutBasis: "100.00", commissionRate: "0.150000", commissionPaid: "15.00", eligibleRefundsSinceCloseout: "30.00", recoveryAlreadyRecorded: "3.00" })).toBe("1.50");
    expect(calculatePostCloseoutCommissionRecovery({ closeoutBasis: "100.00", commissionRate: "0.150000", commissionPaid: "15.00", eligibleRefundsSinceCloseout: "100.00", recoveryAlreadyRecorded: "15.00" })).toBe("0.00");
    expect(() => calculatePostCloseoutCommissionRecovery({ closeoutBasis: "10.00", commissionRate: "0.150000", commissionPaid: "1.50", eligibleRefundsSinceCloseout: "11.00", recoveryAlreadyRecorded: "0.00" })).toThrow(/exceeds/);
  });
  it("separates refunds after closeout from earlier refunds without relying on timestamps", () => {
    expect(refundedCommissionBasisAfterCloseout({ originalEligibleBasis: "100.00", closeoutEligibleBasis: "80.00", allCompletedRefundBasis: "20.00" })).toBe("0.00");
    expect(refundedCommissionBasisAfterCloseout({ originalEligibleBasis: "100.00", closeoutEligibleBasis: "80.00", allCompletedRefundBasis: "35.00" })).toBe("15.00");
    expect(() => refundedCommissionBasisAfterCloseout({ originalEligibleBasis: "100.00", closeoutEligibleBasis: "80.00", allCompletedRefundBasis: "10.00" })).toThrow(/reconcile/);
  });
  it("is deterministic across duplicate/retried calculation", () => {
    const input = [order({ deliveryMethod: "csr_delivery", deliveryFee: "9.99", tipAmount: "2.00" })];
    expect(calculateShiftEarnings(input, 17)).toEqual(calculateShiftEarnings(input, 17));
  });
  it("retries only serialization failures and eventually returns the committed result", async () => {
    let attempts = 0;
    await expect(withSerializableRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("retry transaction"), { code: "40001" });
      return "committed";
    })).resolves.toBe("committed");
    expect(attempts).toBe(3);
  });
  it("does not retry unrelated database failures", async () => {
    let attempts = 0;
    await expect(withSerializableRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    })).rejects.toMatchObject({ code: "23505" });
    expect(attempts).toBe(1);
  });
  it("returns a controlled exhausted error after bounded serialization retries", async () => {
    let attempts = 0;
    await expect(withSerializableRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error("serialization"), { code: "40001" });
    })).rejects.toBeInstanceOf(ShiftCloseoutSerializationError);
    expect(attempts).toBe(3);
  });
});
