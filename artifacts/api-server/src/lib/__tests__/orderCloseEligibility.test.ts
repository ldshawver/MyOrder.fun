import { describe, expect, it } from "vitest";
import { isFinanciallyClosedForFulfillment } from "../orderCloseEligibility";
import { IllegalOrderTransitionError, nextStateForOrderAction } from "../orderStateMachine";

const paidPayPal = {
  paymentStatus: "paid",
  paymentMethod: "paypal",
  total: "1.09",
  customerCreditApplied: "0.00",
  completedCaptureAmount: "1.09",
};

describe("paid pickup close eligibility", () => {
  it("allows an exactly settled PayPal order after it becomes ready", () => {
    expect(isFinanciallyClosedForFulfillment(paidPayPal)).toBe(true);
    expect(nextStateForOrderAction("ready", "complete")).toMatchObject({ to: "completed", changed: true });
  });

  it("rejects an unpaid order even when the provider amount appears sufficient", () => {
    expect(isFinanciallyClosedForFulfillment({ ...paidPayPal, paymentStatus: "unpaid" })).toBe(false);
  });

  it("does not let payment bypass claim, preparation, and ready transitions", () => {
    for (const state of ["submitted", "in_progress", "preparing"]) {
      expect(() => nextStateForOrderAction(state, "complete")).toThrow(IllegalOrderTransitionError);
    }
  });

  it("makes a completed to completed transition idempotent", () => {
    expect(nextStateForOrderAction("completed", "complete")).toMatchObject({ changed: false });
  });

  it("rejects an actual PayPal balance even when the payment flag is paid", () => {
    expect(isFinanciallyClosedForFulfillment({ ...paidPayPal, completedCaptureAmount: "1.08" })).toBe(false);
  });

  it("counts only the credit plus completed PayPal capture for split tender", () => {
    expect(isFinanciallyClosedForFulfillment({ ...paidPayPal, paymentMethod: "customer_credit+paypal", total: "65.25", customerCreditApplied: "40.00", completedCaptureAmount: "25.25" })).toBe(true);
    expect(isFinanciallyClosedForFulfillment({ ...paidPayPal, paymentMethod: "customer_credit+paypal", total: "65.25", customerCreditApplied: "40.00", completedCaptureAmount: "25.24" })).toBe(false);
  });

  it("does not impose a PayPal capture on settled Cash or legacy Card fulfillment", () => {
    for (const paymentMethod of ["cash", "card", "customer_credit"]) {
      expect(isFinanciallyClosedForFulfillment({ ...paidPayPal, paymentMethod, completedCaptureAmount: "0.00" })).toBe(true);
      expect(nextStateForOrderAction("ready", "complete").changed).toBe(true);
    }
  });
});
