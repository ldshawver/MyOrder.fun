import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cartContext = readFileSync(new URL("../CartContext.tsx", import.meta.url), "utf8");
const newOrder = readFileSync(new URL("../../pages/new-order.tsx", import.meta.url), "utf8");

describe("cart quantity integrity", () => {
  it("shows direct increment and decrement controls in the order cart", () => {
    expect(newOrder).toContain("button-decrease-${item.id}");
    expect(newOrder).toContain("button-increase-${item.id}");
    expect(newOrder).toContain("{item.quantity}");
  });

  it("removes a line that would otherwise reach zero and rejects non-integer quantities", () => {
    const updateQuantity = cartContext.slice(cartContext.indexOf("const updateQuantity"), cartContext.indexOf("const setQuantity"));
    expect(updateQuantity).toContain("Number.isSafeInteger(delta)");
    expect(updateQuantity).toContain("return quantity > 0 ? [{ ...i, quantity }] : [];");
    expect(cartContext).toContain("if (!Number.isSafeInteger(quantity)) return;");
  });
});
