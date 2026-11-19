import { describe, expect, it } from "vitest";
import { shouldShowGeneralQueueBanner } from "../queueVisibility";

describe("general queue banner visibility", () => {
  const base = { canManageQueue: true, customerStorefront: false, hasQueueStatus: true, hasActiveShift: false };

  it("is never shown to customer storefronts", () => {
    expect(shouldShowGeneralQueueBanner({ ...base, customerStorefront: true })).toBe(false);
  });

  it("is hidden while a live CSR shift exists and otherwise shown only to queue staff", () => {
    expect(shouldShowGeneralQueueBanner({ ...base, hasActiveShift: true })).toBe(false);
    expect(shouldShowGeneralQueueBanner(base)).toBe(true);
    expect(shouldShowGeneralQueueBanner({ ...base, canManageQueue: false })).toBe(false);
  });
});
