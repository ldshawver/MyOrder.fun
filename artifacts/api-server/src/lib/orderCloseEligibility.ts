import { dollarsToCents } from "./tenderTax";

export function isFinanciallyClosedForFulfillment(input: {
  paymentStatus: string;
  paymentMethod: string | null;
  total: string;
  customerCreditApplied: string | null;
  completedCaptureAmount: string;
}): boolean {
  if (input.paymentStatus !== "paid") return false;
  // The remaining_tender_amount column records the original tender quote.
  // It is not decremented on capture and therefore is not an outstanding balance.
  if (!(input.paymentMethod ?? "").includes("paypal")) return true;
  return dollarsToCents(input.total) <=
    dollarsToCents(input.customerCreditApplied) + dollarsToCents(input.completedCaptureAmount);
}
