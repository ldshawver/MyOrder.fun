// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import AdminEditCatalog from "../admin/edit-catalog";
import AdminInventory from "../admin/inventory";

const auth = vi.hoisted(() => ({ getToken: async () => "test-token" }));
vi.mock("@clerk/react", () => ({ useAuth: () => auth }));
vi.mock("@workspace/api-client-react", () => ({ useGetCurrentUser: () => ({ data: { role: "global_admin" } }) }));

it("shows one inventory row with location columns and distinguishes zero from missing stock", async () => {
  const locations = [{ id: 1, name: "Storefront" }, { id: 2, name: "Backstock" }];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path === "/api/admin/inventory" ? {
    locations,
    items: [{
      id: 17, name: "Test product", category: "Test category", stockUnit: "each",
      inventoryStatus: "missing_balance", totalStock: null,
      locations: [{ locationId: 1, qty: 0, par: 2, hasBalance: true }, { locationId: 2, qty: null, hasBalance: false }],
    }],
  } : { sections: [], items: [], balances: [], notes: [] })));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AdminInventory)));
    const table = host.querySelector('table[aria-label="Test category inventory"]');
    expect(Array.from(table?.querySelectorAll("thead th") ?? [], cell => cell.textContent))
      .toEqual(["Item", "Storefront", "Backstock", "Total stock", "Actions"]);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    const cells = table?.querySelectorAll("tbody td");
    expect(cells?.[0]?.textContent).toBe("0PAR 2");
    expect(cells?.[1]?.textContent).toBe("Not counted");
    expect(cells?.[3]?.textContent).toContain("Opening Count");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("edits product details inline beside the matching variant and shared location counts", async () => {
  const item = { id: 17, name: "Legacy name", alavontName: "Vendor product", customerSafeName: "Safe product",
    alavontDescription: "Vendor description", alavontImageUrl: "https://example.com/vendor.png",
    merchantCategory: "Safe category", merchantImage: "https://example.com/safe.png", merchantSku: "SAFE-17",
    luciferCruzName: "Legacy alias", luciferCruzDescription: "Legacy description", category: "Test category",
    price: 10, isAvailable: true, lifecycleStatus: "customer_visible" };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/catalog/17" && init?.method === "PATCH") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json(item);
    }
    if (path.startsWith("/api/catalog?")) return Response.json({ items: [item] });
    if (path === "/api/admin/catalogue/products") return Response.json({ products: [{
      id: 4, name: "Vendor product", inventoryModel: "SHARED", locationEvaluation: "COMBINED_LOCATIONS",
      options: [{ id: 5, catalogItemId: 17, label: "Test variant", inventoryItemId: 34, optionValues: {}, price: "10",
        active: true, isAvailable: true, inventoryStatus: "ready", consumptionQuantity: "1" }],
    }] });
    if (path === "/api/admin/catalogue/inventory/34/locations") return Response.json({ locations: [
      { locationId: 1, name: "Storefront", quantityOnHand: "0", hasBalance: true },
      { locationId: 2, name: "Backstock", quantityOnHand: "0", hasBalance: false },
    ] });
    return Response.json({ items: [] });
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => root.render(createElement(QueryClientProvider, { client, children: createElement(AdminEditCatalog) })));
    await vi.waitFor(() => expect(host.querySelector('button[title="Edit"]')).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
    await vi.waitFor(() => expect(host.querySelector('input[aria-label="Storefront on hand"]')).not.toBeNull());
    expect(host.querySelector('section[aria-label="Product details"]')?.textContent).toContain("Vendor Name");
    const details = host.querySelector('section[aria-label="Product details"]')?.textContent;
    for (const label of ["Safe Name", "Alavont Description", "Alavont Image URL", "Alavont Category", "Safe Description",
      "Safe Image URL", "Safe Category", "Safe SKU", "Safe stock", "Safe PAR", "Safe Price",
      "Safe Sale Price", "Safe Regular / Compare-at Price", "Safe Employee Discount", "Available for ordering",
      "Show stock count", "Sale marker", "Sale (charge sale price)"]) expect(details).toContain(label);
    expect(host.querySelector('section[aria-label="Product details"]')?.textContent).not.toContain("LC Display Name");
    expect(host.querySelector('input[aria-label="Backstock on hand"]')?.getAttribute("placeholder")).toBe("Not counted");
    expect(host.textContent).toContain("Shared inventory pool #34");
    const save = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save Changes");
    await act(async () => save!.click());
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      alavontName: "Vendor product", alavontDescription: "Vendor description", alavontImageUrl: "https://example.com/vendor.png",
      customerSafeName: "Safe product", merchantCategory: "Safe category", merchantImage: "https://example.com/safe.png", merchantSku: "SAFE-17",
      isSaleFeatured: false, activeSale: false,
    });
    expect(writes[0]).not.toHaveProperty("stockQuantity");
    expect(writes[0]).not.toHaveProperty("luciferCruzName");
    expect(writes[0]).not.toHaveProperty("luciferCruzDescription");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
