import { describe, expect, it } from "vitest";
import { shouldShowGeneralQueueBanner } from "../queueVisibility";

describe("general queue banner visibility", () => {
  const base = { canManageQueue: true, isCustomer: false, hasQueueStatus: true, hasActiveShift: false };

  it("is never shown to a customer because visibility is role-based, not route-based", () => {
    expect(shouldShowGeneralQueueBanner({ ...base, isCustomer: true })).toBe(false);
  });

  it("is hidden while a live CSR shift exists and otherwise shown only to queue staff", () => {
    expect(shouldShowGeneralQueueBanner({ ...base, hasActiveShift: true })).toBe(false);
    expect(shouldShowGeneralQueueBanner(base)).toBe(true);
    expect(shouldShowGeneralQueueBanner({ ...base, canManageQueue: false })).toBe(false);
  });

  it("does not imply a general queue while status is loading, unavailable, or failed", () => {
    expect(shouldShowGeneralQueueBanner({ ...base, hasQueueStatus: false })).toBe(false);
  });
});
