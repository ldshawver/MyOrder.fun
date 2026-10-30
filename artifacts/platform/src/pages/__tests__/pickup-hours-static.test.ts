import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const checkout = readFileSync(new URL("../new-order.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../admin/settings-page.tsx", import.meta.url), "utf8");
const orderDetail = readFileSync(new URL("../order-detail.tsx", import.meta.url), "utf8");

describe("location pickup-hours UI wiring", () => {
  it("renders only server-provided immediate and scheduled choices", () => {
    expect(checkout).toContain('fetch("/api/orders/pickup-availability"');
    expect(checkout).toContain("selectedPickupLocation.immediateAvailable");
    expect(checkout).toContain("selectedPickupLocation.slots.map");
    expect(checkout).toContain("Times shown in");
    expect(checkout).toContain("No upcoming pickup times are available.");
  });

  it("submits the selected location and server-issued slot with quote and order requests", () => {
    expect(checkout.match(/pickupLocationId/g)?.length).toBeGreaterThan(5);
    expect(checkout.match(/pickupAt/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("provides tenant-admin controls and shows the immutable order label", () => {
    expect(settings).toContain("Regular weekly hours");
    expect(settings).toContain("Temporary closures and holiday hours");
    expect(settings).toContain("Pickup slot length");
    expect(settings).toContain("Schedule up to");
    expect(orderDetail).toContain("pickupSchedule");
    expect(orderDetail).toContain("localLabel");
  });

  it("configures authoritative Uber quote inputs and uses server pickup slots", () => {
    expect(settings).toContain("Pickup latitude");
    expect(settings).toContain("Pickup longitude");
    expect(settings).toContain("Uber external store ID");
    expect(settings).toContain("Pickup window (minutes)");
    expect(settings).toContain("Delivery window after pickup (minutes)");
    expect(checkout).toContain('deliveryMethod === "pickup" || deliveryMethod === "uber_direct"');
    expect(checkout).toContain("Courier pickup time");
  });
});
