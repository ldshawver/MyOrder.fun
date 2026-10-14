import { describe, expect, it } from "vitest";
import { allocateCumulativeQuantityCents, allocateOrderLineRefundTax, allocateProportionalRefund, parseOriginalTenderAllocations } from "../refundAccounting";

describe("refund accounting", () => {
  it("allocates a partial split refund proportionally with deterministic cents", () => {
    expect(allocateProportionalRefund({
      cumulativeRefundCents: 5438,
      original: [{ tender: "customer_credit", amountCents: 4000 }, { tender: "cash", amountCents: 6875 }],
      alreadyRefunded: { customer_credit: 0, cash: 0, paypal: 0 },
    })).toEqual({ customer_credit: 2000, cash: 3438, paypal: 0 });
  });

  it("reconciles multiple cumulative partial refunds exactly", () => {
    const original = [{ tender: "customer_credit" as const, amountCents: 4000 }, { tender: "paypal" as const, amountCents: 6875 }];
    const first = allocateProportionalRefund({ cumulativeRefundCents: 5438, original, alreadyRefunded: { customer_credit: 0, cash: 0, paypal: 0 } });
    const second = allocateProportionalRefund({ cumulativeRefundCents: 10875, original, alreadyRefunded: first });
    expect(first).toEqual({ customer_credit: 2000, cash: 0, paypal: 3438 });
    expect(second).toEqual({ customer_credit: 2000, cash: 0, paypal: 3437 });
    expect(first.customer_credit + second.customer_credit).toBe(4000);
    expect(first.paypal + second.paypal).toBe(6875);
  });

  it("refunds customer-credit-only orders through the original tender and amount limits", () => {
    const original = [{ tender: "customer_credit" as const, amountCents: 10875 }];
    const first = allocateProportionalRefund({ cumulativeRefundCents: 5438, original, alreadyRefunded: { customer_credit: 0, cash: 0, paypal: 0 } });
    expect(first).toEqual({ customer_credit: 5438, cash: 0, paypal: 0 });
    const rest = allocateProportionalRefund({ cumulativeRefundCents: 10875, original, alreadyRefunded: first });
    expect(rest).toEqual({ customer_credit: 5437, cash: 0, paypal: 0 });
  });

  it("rejects refunds beyond source caps and unreconcilable prior source allocations", () => {
    const original = [{ tender: "customer_credit" as const, amountCents: 4000 }, { tender: "cash" as const, amountCents: 6875 }];
    expect(() => allocateProportionalRefund({ cumulativeRefundCents: 10876, original, alreadyRefunded: { customer_credit: 0, cash: 0, paypal: 0 } })).toThrow(/exceeds original/);
    expect(() => allocateProportionalRefund({ cumulativeRefundCents: 5438, original, alreadyRefunded: { customer_credit: 2500, cash: 0, paypal: 0 } })).toThrow(/conflict/);
  });

  it("keeps cumulative two-source allocations monotone and rejects unsupported three-way history", () => {
    const original = [{ tender: "customer_credit" as const, amountCents: 3333 }, { tender: "paypal" as const, amountCents: 6667 }];
    let prior = { customer_credit: 0, cash: 0, paypal: 0 };
    for (let cumulative = 1; cumulative <= 10000; cumulative++) {
      const next = allocateProportionalRefund({ cumulativeRefundCents: cumulative, original, alreadyRefunded: prior });
      expect(next.customer_credit).toBeGreaterThanOrEqual(0);
      expect(next.paypal).toBeGreaterThanOrEqual(0);
      prior = { customer_credit: prior.customer_credit + next.customer_credit, cash: 0, paypal: prior.paypal + next.paypal };
    }
    expect(prior).toEqual({ customer_credit: 3333, cash: 0, paypal: 6667 });
    expect(parseOriginalTenderAllocations({ schemaVersion: 1, totalCents: 100, allocations: [
      { tender: "customer_credit", amountCents: 20 }, { tender: "cash", amountCents: 30 }, { tender: "paypal", amountCents: 50 },
    ] }, 100)).toBeNull();
  }, 15_000);

  it("parses only complete immutable tender allocations and rejects incomplete history", () => {
    expect(parseOriginalTenderAllocations({ schemaVersion: 1, totalCents: 10875, allocations: [
      { tender: "customer_credit", amountCents: 4000 }, { tender: "cash", amountCents: 6875 },
    ] }, 10875)).toHaveLength(2);
    expect(parseOriginalTenderAllocations({ schemaVersion: 1, totalCents: 10875, allocations: [
      { tender: "customer_credit", amountCents: 4000 },
    ] }, 10875)).toBeNull();
  });

  it("splits line-level cents cumulatively so sequential partial returns equal the original", () => {
    const first = allocateCumulativeQuantityCents({ totalCents: 1001, totalQuantity: 3, priorQuantity: 0, currentQuantity: 1 });
    const second = allocateCumulativeQuantityCents({ totalCents: 1001, totalQuantity: 3, priorQuantity: 1, currentQuantity: 1 });
    const final = allocateCumulativeQuantityCents({ totalCents: 1001, totalQuantity: 3, priorQuantity: 2, currentQuantity: 1 });
    expect([first, second, final]).toEqual([334, 333, 334]);
    expect(first + second + final).toBe(1001);
  });

  it("allocates discounts and tax only across taxable order lines", () => {
    const rows = allocateOrderLineRefundTax({
      lines: [
        { lineIndex: 0, orderItemId: 10, catalogItemId: 1, quantity: 1, unitPriceCents: 10000, taxable: true },
        { lineIndex: 1, orderItemId: 11, catalogItemId: 2, quantity: 1, unitPriceCents: 2000, taxable: false },
      ],
      taxableDiscountCents: 500,
      nonTaxableDiscountCents: 100,
      taxCents: 831,
    });
    expect(rows).toEqual([
      { lineIndex: 0, orderItemId: 10, catalogItemId: 1, quantity: 1, grossCents: 10000, discountCents: 500, taxable: true, taxableBaseCents: 9500, taxCents: 831 },
      { lineIndex: 1, orderItemId: 11, catalogItemId: 2, quantity: 1, grossCents: 2000, discountCents: 100, taxable: false, taxableBaseCents: 0, taxCents: 0 },
    ]);
  });
});
