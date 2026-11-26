import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({ db: {} }));
import { activeStorefrontClosure, closureSettingsBody } from "../storefrontClosures";

const windows = [{ startsAt: "2026-11-26T08:00:00Z", endsAt: "2026-11-27T08:00:00Z", message: "Closed for the holiday" }];

describe("storefront closures", () => {
  it("closes at the start and reopens at the exact end", () => {
    const [closure] = windows;
    expect(activeStorefrontClosure(windows, Date.parse(closure.startsAt) - 1)).toBeNull();
    expect(activeStorefrontClosure(windows, Date.parse(closure.startsAt))).toEqual(closure);
    expect(activeStorefrontClosure(windows, Date.parse(closure.endsAt))).toBeNull();
  });

  it("rejects invalid intervals, missing messages and overlapping windows", () => {
    expect(closureSettingsBody.safeParse({ version: 0, windows }).success).toBe(true);
    expect(closureSettingsBody.safeParse({ version: 0, windows: [...windows, ...windows] }).success).toBe(false);
    expect(closureSettingsBody.safeParse({ version: 1, windows: [{ ...windows[0], message: " " }] }).success).toBe(false);
    expect(closureSettingsBody.safeParse({ version: 1, windows: [{ ...windows[0], endsAt: windows[0].startsAt }] }).success).toBe(false);
  });
});
