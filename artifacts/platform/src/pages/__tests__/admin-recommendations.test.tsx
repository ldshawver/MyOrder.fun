// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: auth.getToken }) }));
vi.mock("@workspace/api-client-react", () => ({ useGetCurrentUser: () => ({ data: { role: "global_admin" } }) }));
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

it("keeps variants, location inventory, and Global Admin compliance controls together on the selected catalogue item", async () => {
  let held = false;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/admin/catalogue/products") return new Response(JSON.stringify({ products: [{
      id: 7, name: "Test Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION",
      options: [{ id: 9, catalogItemId: 70, label: "Black / Small", optionValues: { Color: "Black", Size: "Small" }, sku: "TS-BS", price: "12.00", compareAtPrice: null, active: true, isAvailable: true, inventoryItemId: 90, baseUnit: "each", consumptionQuantity: "1", complianceHold: held, complianceReason: held ? "Review required" : null }],
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/inventory/90/locations") return new Response(JSON.stringify({ locations: [{ locationId: 2, name: "Main", quantityOnHand: "4", par: "0", reorderPoint: "0", preferredReorderQuantity: "0", moq: "0" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/product-master/70/lifecycle" && init?.method === "PATCH") {
      held = JSON.parse(String(init.body)).complianceHold;
      return new Response(JSON.stringify({ item: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Test Shirt"));
  await act(async () => host!.querySelector("aside button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host?.textContent).toContain("Compliance Hold"));
  expect([...host!.querySelectorAll("input")].some(input => input.value === "Color=Black; Size=Small")).toBe(true);
  expect(host?.textContent).toContain("Inventory item #90 by location");
  expect(host?.textContent).toContain("Main");
  const reason = host!.querySelector('input[aria-label="Compliance action reason"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Review required");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    reason.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const placeHold = [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Place hold"));
  expect(placeHold).toBeTruthy();
  await act(async () => placeHold!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/product-master/70/lifecycle", expect.objectContaining({ method: "PATCH" })));
  expect(JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/admin/product-master/70/lifecycle")?.[1]?.body))).toEqual({ complianceHold: true, reason: "Review required" });
});
