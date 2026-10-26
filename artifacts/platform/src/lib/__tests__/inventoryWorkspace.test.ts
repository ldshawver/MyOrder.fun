import { describe, expect, it, vi } from "vitest";
import { catalogueItemsAtLocation, loadInventoryWorkspace } from "../inventoryWorkspace";

const empty = { items: [] };

describe("inventory workspace loading", () => {
  it("loads every inventory panel and accepts authoritative empty success responses", async () => {
    const request = vi.fn(async () => empty);
    const data = await loadInventoryWorkspace(request);
    expect(request).toHaveBeenCalledTimes(4);
    expect(data).toEqual({ catalogue: empty, sections: empty, items: empty, balances: empty });
  });

  it.each([401, 403, 500])("does not convert HTTP %i into an empty inventory", async status => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/admin/non-catalog/items") throw new Error(`Inventory request failed (${status})`);
      return empty;
    });
    await expect(loadInventoryWorkspace(request)).rejects.toThrow(`Inventory request failed (${status})`);
  });

  it("surfaces network failures and allows the caller to retry the full snapshot", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(empty);
    await expect(loadInventoryWorkspace(request)).rejects.toThrow("offline");
    const retried = await loadInventoryWorkspace(request);
    expect(retried.catalogue).toEqual(empty);
    expect(request).toHaveBeenCalledTimes(8);
  });

  it("keeps items with missing location balances visible under a location filter", () => {
    const products = [
      { id: 1, locations: [{ locationId: 10 }] },
      { id: 2, locations: [{ locationId: 20 }] },
      { id: 3, locations: [] },
    ];
    expect(catalogueItemsAtLocation(products, 10).map(row => row.id)).toEqual([1, 2, 3]);
    expect(catalogueItemsAtLocation(products, null)).toEqual(products);
  });
});
