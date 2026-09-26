import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cartContext = readFileSync(new URL("../CartContext.tsx", import.meta.url), "utf8");
const newOrder = readFileSync(new URL("../../pages/new-order.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

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

  it("keeps persisted carts scoped to the authenticated customer", () => {
    expect(cartContext).toContain('import { useAuth } from "@clerk/react";');
    expect(cartContext).toContain("const storageKey = isLoaded && userId ? `${STORAGE_KEY}:${userId}` : null;");
    expect(cartContext).toContain("cartState.storageKey !== storageKey");
    expect(cartContext).toContain("localStorage.getItem(storageKey)");
    expect(cartContext).not.toContain("localStorage.getItem(STORAGE_KEY)");
  });

  it("mounts the cart provider within Clerk before rendering routes", () => {
    const clerkTree = app.slice(app.indexOf("function ClerkProviderWithRoutes()"), app.indexOf("class ClerkInitializationBoundary"));
    const appTree = app.slice(app.indexOf("function App()"));
    expect(clerkTree).toMatch(/<ClerkProvider\b[\s\S]*<CartProvider>[\s\S]*<Router\s*\/>[\s\S]*<\/CartProvider>[\s\S]*<\/ClerkProvider>/);
    expect(appTree).not.toContain("<CartProvider>");
  });
});
