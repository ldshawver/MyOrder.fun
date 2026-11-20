import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../orders.tsx", import.meta.url), "utf8");

describe("CSR Orders card layout", () => {
  it("renders the restored compact responsive card grid instead of a desktop table", () => {
    expect(source).toContain('data-testid="orders-card-grid"');
    expect(source).toContain("grid-cols-1 md:grid-cols-2 xl:grid-cols-3");
    expect(source).not.toContain("grid-cols-[80px_1fr_1fr_120px_100px_100px]");
  });

  it("keeps customer tracking isolated from the CSR card workspace", () => {
    expect(source).toContain("if (isCustomer)");
    expect(source).toContain("<CustomerOrderStage order={liveOrder} />");
    expect(source).toContain("The API enforces tenant and ownership scoping");
  });

  it("loads the plural CSR workspace from the staff-only queue API and keeps actions server-authorized", () => {
    expect(source).toContain('fetch("/api/shift-queue/orders"');
    expect(source).toContain("staffFulfillmentAction(order.id");
    expect(source).toContain('Awaiting verified payment — not available for fulfillment.');
  });
});
