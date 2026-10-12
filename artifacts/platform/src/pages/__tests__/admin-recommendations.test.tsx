// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: auth.getToken }) }));
import AdminCatalogueProducts from "../admin/catalogue-products";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

it("shows Coffee Beans transfer and purchase as distinct suggestions without changing inventory", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    paths.push(path);
    expect(init?.method).toBeUndefined();
    const payload = path.endsWith("/products") ? { products: [] } : { items: [{
      inventoryItemId: 182, productName: "Coffee Beans", baseUnit: "g", recommendations: [
        { locationId: 1, locationName: "Backstock", internalTransfers: [{ fromLocationId: 2, quantity: "1000.000000" }],
          externalPurchaseQuantity: "2000.000000" },
        { locationId: 2, locationName: "Storefront", internalTransfers: [], externalPurchaseQuantity: "0.000000" },
      ],
    }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Suggested external purchase: 2000.000000 g"));
  expect(host.textContent).toContain("Suggested internal transfer: Storefront → Backstock · 1000.000000 g");
  expect(host.textContent).toContain("No inventory transfer or purchase has been created");
  expect(paths).toEqual(["/api/admin/catalogue/products", "/api/admin/catalogue/recommendations"]);
});
