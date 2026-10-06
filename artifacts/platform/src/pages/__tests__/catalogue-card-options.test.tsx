// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ addItem: vi.fn(), getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: state.getToken }) }));
vi.mock("@/contexts/BrandContext", () => ({ useBrand: () => ({ brand: "alavont", branding: {
  customer: { displayName: "Alavont" }, supplier: { displayName: "Supplier" },
} }) }));
vi.mock("@/contexts/CartContext", () => ({ useCart: () => ({ cart: [], itemCount: 0, addItem: state.addItem }) }));
vi.mock("@/components/CatalogNotice", () => ({ CatalogNotice: () => null }));
vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({ data: { role: "customer" } }),
  useUpdateCatalogItem: () => ({ mutate: vi.fn(), isPending: false }),
  getListCatalogItemsQueryKey: () => ["listCatalogItems"],
}));

import Catalog from "../catalog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Option = { id: number; catalogItemId: number; label: string; price: string; sku: string | null };
const shirtOptions: Option[] = [
  { id: 179, catalogItemId: 182, label: "Small", price: "20.00", sku: "TS-S" },
  { id: 180, catalogItemId: 183, label: "Medium", price: "22.00", sku: "TS-M" },
  { id: 181, catalogItemId: 184, label: "Large", price: "24.00", sku: "TS-L" },
];

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
  state.addItem.mockClear();
});

async function renderCustomerCatalogue(options: Option[]) {
  const product = { id: 179, name: "T-Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION", active: true, options };
  const items = options.map(option => ({
    id: option.catalogItemId, name: `T-Shirt ${option.label}`, alavontName: `T-Shirt ${option.label}`,
    category: "Apparel", price: Number(option.price), isAvailable: true, isTaxable: true,
    imageUrl: null, stockQuantity: 3, sellableProduct: product,
  }));
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = String(input);
    requests.push(path);
    const payload = path.startsWith("/api/catalog/categories") ? { categories: ["Apparel"] }
      : path.startsWith("/api/catalog?") ? { items, total: items.length, page: 1, limit: 200 }
      : { error: "Not available" };
    return new Response(JSON.stringify(payload), { status: path.startsWith("/api/admin/settings") ? 403 : 200,
      headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Catalog))); });
  await vi.waitFor(() => expect(host?.querySelectorAll('[data-testid^="card-product-"]')).toHaveLength(1));
  expect(requests.some(path => path.startsWith("/api/catalog?"))).toBe(true);
  expect(requests).not.toContain("/api/catalogue/products");
  return host!;
}

describe("actual customer catalogue card", () => {
  it("shows Small, Medium and Large directly on one card and sends Medium's option ID to cart", async () => {
    const page = await renderCustomerCatalogue(shirtOptions);
    const select = page.querySelector('select[aria-label="T-Shirt option"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect([...select.options].map(option => option.textContent)).toEqual([
      "Select an option", "Small · $20.00", "Medium · $22.00", "Large · $24.00",
    ]);
    const add = page.querySelector('[data-testid="link-buy-now-182"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await act(async () => { select.value = "180"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(add.disabled).toBe(false);
    expect(page.textContent).toContain("$22.00");
    await act(async () => add.click());
    expect(state.addItem).toHaveBeenCalledWith(expect.objectContaining({ optionId: 180, id: 183, price: 22,
      name: "T-Shirt — Medium" }));
  });

  it("keeps one Standard option simple while still adding its option ID", async () => {
    const page = await renderCustomerCatalogue([{ id: 179, catalogItemId: 182, label: "Standard", price: "20.00", sku: null }]);
    expect(page.querySelector('select[aria-label="T-Shirt option"]')).toBeNull();
    await act(async () => (page.querySelector('[data-testid="link-buy-now-182"]') as HTMLButtonElement).click());
    expect(state.addItem).toHaveBeenCalledWith(expect.objectContaining({ optionId: 179, id: 182 }));
  });

  it("offers only options present in the sellable customer API response", async () => {
    const page = await renderCustomerCatalogue(shirtOptions.slice(0, 2));
    const labels = [...(page.querySelector('select[aria-label="T-Shirt option"]') as HTMLSelectElement).options]
      .map(option => option.textContent);
    expect(labels).toContain("Small · $20.00");
    expect(labels).toContain("Medium · $22.00");
    expect(labels).not.toContain("Large · $24.00");
  });
});
