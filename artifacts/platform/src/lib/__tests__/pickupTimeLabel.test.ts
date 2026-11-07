import { describe, expect, it } from "vitest";
import { formatPickupSlotLabel } from "../pickupTimeLabel";

describe("pickup slot labels", () => {
  it("shows a 12-hour clock in the location time zone", () => {
    const label = formatPickupSlotLabel("2026-11-01T22:00:00.000Z", "America/Los_Angeles");
    expect(label).toMatch(/2:00/);
    expect(label).toMatch(/PM/);
    expect(label).not.toMatch(/14:00/);
  });
});
