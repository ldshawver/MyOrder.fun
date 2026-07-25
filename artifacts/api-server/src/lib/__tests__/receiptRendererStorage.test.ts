import { describe, expect, it } from "vitest";
import { decodeStoredReceiptText, renderCustomerReceipt } from "../receiptRenderer";

describe("receipt text persistence", () => {
  it("stores ESC/POS receipts without PostgreSQL-forbidden NUL bytes", () => {
    const stored = renderCustomerReceipt({
      id: 1,
      items: [{ name: "Merchant item", quantity: 1, unitPrice: 10, totalPrice: 10 }],
      subtotal: 10,
      total: 10,
    });

    expect(stored).not.toContain("\x00");
    expect(stored).toContain("\u2400");
    expect(decodeStoredReceiptText(stored)).toContain("\x1d\x56\x41\x00");
  });
});
