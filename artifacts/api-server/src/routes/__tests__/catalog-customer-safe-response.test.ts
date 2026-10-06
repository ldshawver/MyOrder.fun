import { describe, expect, it } from "vitest";
import {
  GetCatalogItemResponse,
  ListCatalogItemsResponse,
  UpdateCatalogItemResponse,
} from "@workspace/api-zod";

const item = {
  id: 1,
  tenantId: 1,
  name: "Internal name",
  category: "Internal category",
  price: 10,
  isAvailable: true,
  customerSafeName: "Saved customer name",
  customerSafeDescription: "Saved customer description",
  createdAt: new Date("2026-08-28T00:00:00Z"),
  updatedAt: new Date("2026-08-28T00:00:00Z"),
};

describe("catalog customer-safe response persistence", () => {
  it("preserves both fields in the PATCH response", () => {
    expect(UpdateCatalogItemResponse.parse(item)).toMatchObject({
      customerSafeName: "Saved customer name",
      customerSafeDescription: "Saved customer description",
    });
  });

  it("preserves both fields in fresh item and list GET responses", () => {
    expect(GetCatalogItemResponse.parse(item)).toMatchObject({
      customerSafeName: "Saved customer name",
      customerSafeDescription: "Saved customer description",
    });
    expect(ListCatalogItemsResponse.parse({ items: [item], total: 1, page: 1, limit: 20 }).items[0]).toMatchObject({
      customerSafeName: "Saved customer name",
      customerSafeDescription: "Saved customer description",
    });
  });
});
