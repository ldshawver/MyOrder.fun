import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const catalog = readFileSync(new URL("../../pages/catalog.tsx", import.meta.url), "utf8");
const catalogRoute = readFileSync(new URL("../../../../api-server/src/routes/catalog.ts", import.meta.url), "utf8");

describe("catalogue edit integrity", () => {
  it("does not submit a direct inventory balance replacement from the catalogue editor", () => {
    const saveBody = catalog.slice(catalog.indexOf("const handleSave = () =>"), catalog.indexOf("return (", catalog.indexOf("const handleSave = () =>")));
    expect(saveBody).not.toContain("stockQuantity:");
    expect(catalog).toContain("Inventory quantities are managed through Inventory movements");
  });

  it("keeps the persisted homiePrice field behind the Employee Discount label", () => {
    expect(catalog).toContain('label: "Employee Discount ($)", key: "homiePrice"');
    expect(catalog).not.toContain('label: "Homie Price ($)"');
  });

  it("sorts Featured items without treating Sale as a priority rule", () => {
    const start = catalogRoute.indexOf("rows = rows.sort");
    const sortBody = catalogRoute.slice(start, catalogRoute.indexOf("const stockByCatalogId", start));
    expect(sortBody).toContain("const aRank = a.isFeatured ? 0 : 1;");
    expect(sortBody).not.toContain("isSaleFeatured ||");
  });

  it("rejects unknown catalogue update fields instead of silently accepting them", () => {
    const updateHandler = catalogRoute.slice(catalogRoute.indexOf('router.patch("/catalog/:id"'), catalogRoute.indexOf('router.delete("/catalog/:id"'));
    expect(updateHandler).toContain("UpdateCatalogItemBody.strict().safeParse(req.body)");
  });

  it("continues loading customer catalogue pages instead of silently truncating after the first 200 rows", () => {
    expect(catalog).toContain("useInfiniteQuery");
    expect(catalog).toContain("getNextPageParam: lastPage => lastPage.page * lastPage.limit < lastPage.total ? lastPage.page + 1 : undefined");
    expect(catalog).toContain("void catalogQuery.fetchNextPage()");
    expect(catalog).toContain("catalogQuery.data?.pages.flatMap(page => page.items)");
  });
});
