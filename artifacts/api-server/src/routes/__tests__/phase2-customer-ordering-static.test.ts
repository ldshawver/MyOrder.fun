import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const api = (file: string) => readFileSync(resolve(here, "..", file), "utf8");
const platform = (file: string) => readFileSync(resolve(here, "../../../../platform/src", file), "utf8");

describe("Phase 2 customer ordering boundaries", () => {
  it("does not expose non-customer catalog items by direct id", () => {
    const source = api("catalog.ts");
    expect(source).toContain("metadata.archived === true");
    expect(source).toContain('res.status(404).json({ error: "Not found" })');
    expect(source).toContain("internalName: alavontOnly ? null");
    expect(source).toContain("metadata: alavontOnly ? {} : i.metadata");
    expect(readFileSync(resolve(here, "../../lib/catalogEligibility.ts"), "utf8")).not.toContain("eq(catalogItemsTable.isAvailable, true)");
  });

  it("enforces ordering availability at cart conversion and checkout, independent of stock display", () => {
    const orders = api("orders.ts");
    expect(orders.match(/ci\.is_available = true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(orders).not.toContain("alavont_in_stock IS DISTINCT FROM false");
    expect(orders).not.toContain("showCatalogueStockIndicator");
    expect(readFileSync(resolve(here, "../../lib/catalogueSellable.ts"), "utf8")).toContain("ci.is_available IS NOT TRUE");
  });

  it("bounds Zappy cart proposals before the client applies them", () => {
    const source = api("ai.ts");
    expect(source).toContain("Number.isInteger(quantity)");
    expect(source).toContain("quantity > 99");
  });

  it("routes customers to one Cart and Checkout experience", () => {
    const app = platform("App.tsx");
    const cart = platform("pages/new-order.tsx");
    const catalog = platform("pages/catalog.tsx");
    expect(app).toContain('path="/cart" component={NewOrder}');
    expect(app).toContain('path="/checkout" component={NewOrder}');
    expect(app).toContain('path="/order-workspace" component={LegacyCartRedirect}');
    expect(app).toContain('path="/orders/new" component={LegacyCartRedirect}');
    expect(cart).toContain('data-testid="text-title">My Order</h1>');
    expect(cart).toContain("Optional Zappy suggestions");
    expect(catalog).toContain('data-testid="catalog-cart-link"');
    expect(catalog).toContain('data-testid="catalog-checkout-link"');
  });
});
