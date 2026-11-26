import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../speed-order.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../../components/layout.tsx", import.meta.url), "utf8");

describe("Speed Order staff screen", () => {
  it("uses the server-ranked top nine and same-tenant member service", () => {
    expect(page).toContain('"/api/speed-order/top-nine"');
    expect(page).toContain("/api/speed-order/members?q=");
    expect(page).toContain('className="grid grid-cols-3 gap-2"');
    expect(page).toContain('"X-Speed-Order-Member-Id"');
  });

  it("shows category controls above products and can load more items into the same order", () => {
    const categoryControls = page.indexOf('aria-label="Product categories"');
    expect(categoryControls).toBeGreaterThan(-1);
    expect(categoryControls).toBeLessThan(page.indexOf('className="grid grid-cols-3 gap-2"'));
    expect(page).toContain('"/api/speed-order/categories"');
    expect(page).toContain("/api/speed-order/category-items?");
    expect(page).toContain("getNextPageParam: page => page.nextCursor");
    expect(page).toContain("changeQuantity(id, 1)");
  });

  it("reuses authoritative conversion, quote, order, and cash closeout", () => {
    expect(page).toContain('"/api/cart/convert"');
    expect(page).toContain('"/api/checkout/quote"');
    expect(page).toContain('"/api/orders"');
    expect(page).toContain("/closeout`");
    expect(page).toContain('paymentMethod: "cash"');
    expect(page).toContain('deliveryMethod: "pickup"');
    expect(page).not.toContain("guest");
  });

  it("is routed and linked only inside the staff surfaces", () => {
    expect(app).toContain('{isStaff && <Route path="/staff/speed-order"');
    expect(layout).toContain('{ href: "/staff/speed-order", label: "Speed Order", icon: Zap, roles: SHIFT_ROLES }');
  });
});
