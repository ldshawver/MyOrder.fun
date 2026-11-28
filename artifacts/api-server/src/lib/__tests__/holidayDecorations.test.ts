import { describe, expect, it } from "vitest";
import { holidaySettingsBody, resolveHoliday, type HolidayPreferences } from "../holidayDecorations";

const automatic: HolidayPreferences = { automatic: true, animated: true, disabled: [], manual: null };
const at = (day: string, settings = automatic) => resolveHoliday(settings, "UTC", new Date(day + "T12:00:00Z"));

describe("holiday decoration calendar", () => {
  it.each([
    ["2026-09-29", null], ["2026-09-30", "halloween"], ["2026-11-01", "thanksgiving"],
    ["2026-11-26", "thanksgiving"], ["2026-11-27", "christmas"], ["2026-12-25", "christmas"],
    ["2026-12-26", "newyear"], ["2027-01-01", "newyear"], ["2027-01-02", null],
    ["2027-01-14", "valentines"], ["2027-02-28", "easter"], ["2027-03-28", "easter"],
    ["2028-03-16", "easter"], ["2028-04-16", "easter"],
    ["2026-05-24", "memorial"], ["2026-05-25", "memorial"], ["2026-05-26", "juneteenth"],
    ["2027-05-31", "memorial"], ["2027-06-01", "juneteenth"],
    ["2026-06-19", "juneteenth"], ["2026-06-20", "independence"], ["2026-07-05", null],
    ["2026-09-07", "labor"], ["2026-09-08", null],
  ])("chooses the expected theme on %s", (day, expected) => expect(at(day)).toBe(expected));

  it("switches at tenant-local midnight, including daylight saving", () => {
    expect(resolveHoliday(automatic, "America/Los_Angeles", new Date("2026-11-27T07:59:59Z"))).toBe("thanksgiving");
    expect(resolveHoliday(automatic, "America/Los_Angeles", new Date("2026-11-27T08:00:00Z"))).toBe("christmas");
    expect(resolveHoliday(automatic, "America/Los_Angeles", new Date("2026-07-05T06:59:59Z"))).toBe("independence");
    expect(resolveHoliday(automatic, "America/Los_Angeles", new Date("2026-07-05T07:00:00Z"))).toBeNull();
    expect(resolveHoliday(automatic, "Pacific/Auckland", new Date("2026-11-27T07:59:59Z"))).toBe("christmas");
  });

  it("applies tenant preferences without modifying other tenants' schedules", () => {
    expect(at("2026-12-20", { ...automatic, disabled: ["christmas"] })).toBe("newyear");
    expect(at("2026-12-20")).toBe("christmas");
    expect(at("2026-12-20", { ...automatic, automatic: false })).toBeNull();
    expect(at("2026-12-20", { ...automatic, automatic: false, manual: "easter" })).toBe("easter");
  });

  it("validates updates with an allowlist and rejects duplicates and tenant selectors", () => {
    expect(holidaySettingsBody.safeParse({ ...automatic, version: 0 }).success).toBe(true);
    for (const extra of [{ tenantId: 2 }, { manual: "unknown" }, { disabled: ["easter", "easter"] }, { version: -1 }]) {
      expect(holidaySettingsBody.safeParse({ ...automatic, version: 0, ...extra }).success).toBe(false);
    }
  });
});
