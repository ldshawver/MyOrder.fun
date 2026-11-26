// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CatalogWorkspace } from "../admin/catalog-workspace";
import AdminInventory from "../admin/inventory";

const auth = vi.hoisted(() => ({ getToken: async () => "test-token" }));
vi.mock("@clerk/react", () => ({ useAuth: () => auth }));

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

it.each([
  ["admin", ["Edit Catalog", "Products & Variants", "Inventory"]],
  ["supervisor", ["Products & Variants", "Inventory"]],
])("keeps the workspace navigation within the %s role", async (role, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CatalogWorkspace, { active: "inventory", role, children: "Inventory content" })));
    expect(Array.from(host.querySelectorAll("nav a"), tab => tab.textContent)).toEqual(expected);
    expect(host.querySelector('nav [aria-current="page"]')?.textContent).toBe("Inventory");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
