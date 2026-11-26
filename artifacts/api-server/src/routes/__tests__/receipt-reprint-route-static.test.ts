import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../print.ts", import.meta.url), "utf8");
const route = source.slice(source.indexOf('router.post("/print/orders/:id/receipt"'), source.indexOf('/** POST /api/print/orders/:id/label'));

describe("receipt reprint route", () => {
  it("is tenant-scoped and queues only an ORDER_RECEIPT document", () => {
    expect(route).toContain("eq(ordersTable.tenantId, tenantId)");
    expect(route).toContain('documentType: "ORDER_RECEIPT"');
    expect(route).toContain("reprint: true");
    expect(route).not.toContain("cashDrawer");
    expect(route).not.toContain("openDrawer");
  });
});
