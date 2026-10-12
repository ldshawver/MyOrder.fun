import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "../inventory.ts"), "utf8");

describe("settled payment inventory recovery", () => {
  it("rechecks each order item against its tenant inventory identity before confirming a paid sale", () => {
    expect(source).toContain("ensurePaidOrderInventoryReserved(tx, order)");
    expect(source).toContain("AND status = 'confirmed' LIMIT 1");
    expect(source).toContain("ii.tenant_id = ${order.tenantId}");
    expect(source).toContain("physicalQuantity, orderTypeForPaidDeduction(order)");
    expect(source).toContain("confirmInventoryReservationsForOrder(tx, order.tenantId, order.id,");
  });
});
