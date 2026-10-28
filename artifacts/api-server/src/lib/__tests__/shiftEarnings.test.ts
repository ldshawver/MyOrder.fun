import { describe, expect, it } from "vitest";
import { calculateShiftEarnings, type ShiftEarningOrder } from "../shiftEarnings";

const order = (patch: Partial<ShiftEarningOrder> = {}): ShiftEarningOrder => ({
  orderId: 1, routeSource: "active_csr", paymentStatus: "paid", deliveryMethod: "pickup", deliveryFee: "0.00", tipAmount: "0.00",
  lines: [{ orderItemId: 10, eligibility: "eligible", grossAmount: "100.00", discountAmount: "20.00", refundedAmount: "0.00" }], ...patch,
});

describe("shift earnings", () => {
  it("calculates commission from discounted eligible product sales", () => {
    expect(calculateShiftEarnings([order()], 15)).toMatchObject({ commissionBasis: "80.00", commissionAmount: "12.00", customerTips: "0.00" });
  });
  it("excludes memberships, explicitly excluded, unclassified, and General Queue sales", () => {
    const excluded = ["membership", "excluded", "unclassified"].map((eligibility, i) => order({ orderId: i + 1, lines: [{ ...order().lines[0]!, eligibility: eligibility as never }] }));
    expect(calculateShiftEarnings([...excluded, order({ orderId: 9, routeSource: "general_account" })], 18).commissionBasis).toBe("0.00");
  });
  it("keeps tips and CSR 80/20 delivery separate", () => {
    expect(calculateShiftEarnings([order({ deliveryMethod: "csr_delivery", deliveryFee: "10.01", tipAmount: "7.25" })], 15)).toMatchObject({ customerTips: "7.25", csrDeliveryEarnings: "8.01", houseDeliveryShare: "2.00", csrPayout: "27.26" });
  });
  it("credits the full quoted Uber fee to the provider and none to the CSR", () => {
    expect(calculateShiftEarnings([order({ deliveryMethod: "uber_direct", deliveryFee: "14.30" })], 15)).toMatchObject({ uberProviderDelivery: "14.30", csrDeliveryEarnings: "0.00", houseDeliveryShare: "0.00" });
  });
  it("reduces commission basis for line refunds without changing the actual tip", () => {
    expect(calculateShiftEarnings([order({ paymentStatus: "partially_refunded", tipAmount: "5.00", lines: [{ ...order().lines[0]!, refundedAmount: "30.00" }] })], 16)).toMatchObject({ commissionBasis: "50.00", commissionAmount: "8.00", customerTips: "5.00" });
    expect(calculateShiftEarnings([order({ paymentStatus: "refunded", tipAmount: "5.00" })], 16)).toMatchObject({ commissionBasis: "0.00", commissionAmount: "0.00", customerTips: "0.00" });
  });
  it("is deterministic across duplicate/retried calculation", () => {
    const input = [order({ deliveryMethod: "csr_delivery", deliveryFee: "9.99", tipAmount: "2.00" })];
    expect(calculateShiftEarnings(input, 17)).toEqual(calculateShiftEarnings(input, 17));
  });
});
