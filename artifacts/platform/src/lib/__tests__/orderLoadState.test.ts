import { describe, expect, it } from "vitest";
import { isOrderAccessFailure } from "../orderLoadState";

describe("order detail loading failures", () => {
  it("classifies only explicit missing/denied responses as access failures", () => {
    expect(isOrderAccessFailure({ status: 403 })).toBe(true);
    expect(isOrderAccessFailure({ status: 404 })).toBe(true);
    expect(isOrderAccessFailure({ status: 429 })).toBe(false);
    expect(isOrderAccessFailure({ status: 503 })).toBe(false);
    expect(isOrderAccessFailure(new TypeError("network unavailable"))).toBe(false);
  });
});
