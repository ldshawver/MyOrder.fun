import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const orders = readFileSync(new URL("../orders.ts", import.meta.url), "utf8");
const settings = readFileSync(new URL("../settings.ts", import.meta.url), "utf8");
const payment = readFileSync(new URL("../../payments/service.ts", import.meta.url), "utf8");

describe("pickup scheduling route safety", () => {
  it("validates tenant-owned active storefront locations for reads and writes", () => {
    expect(settings).toContain('eq(inventoryLocationsTable.tenantId, tenantId)');
    expect(settings).toContain('eq(inventoryLocationsTable.type, "storefront")');
    expect(settings).toContain('eq(inventoryLocationsTable.isActive, true)');
    expect(settings).toContain("before: auditSchedule(result.previous)");
    expect(settings).toContain("after: auditSchedule(saved)");
    expect(orders).toContain('resolvePickupLocation(houseTenantId, body.data.pickupLocationId)');
    expect(orders).toContain('loadPickupSchedule(houseTenantId, pickupLocation.id)');
  });

  it("revalidates pickup selection during quote and order creation and persists its snapshot", () => {
    expect(orders.match(/validatePickupSelection\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(orders).toContain("pickupScheduleSnapshot: pickupSnapshot");
    expect(orders).toContain("pickupLocationId: pickupLocation?.id ?? null");
    expect(orders).toContain("pickupAt: pickupSelection?.pickupAt ?? null");
    expect(orders).toContain('error: "PICKUP_ADDRESS_NOT_ALLOWED"');
    expect(orders).toContain("FROM location_pickup_schedules");
    expect(orders).toContain("FOR SHARE");
    expect(orders).toContain('error: "PICKUP_SCHEDULE_CHANGED"');
  });

  it("does not make payment retry depend on mutable current pickup hours", () => {
    expect(payment).not.toContain("loadPickupSchedule");
    expect(payment).not.toContain("validatePickupSelection");
  });

  it("keeps authoritative inventory reservation in the same order transaction", () => {
    expect(orders).toContain("reserveCheckoutInventoryByOrderType(tx, houseTenantId, createdOrder.id");
    expect(orders).toContain("throw new InsufficientInventoryError(");
  });
});
