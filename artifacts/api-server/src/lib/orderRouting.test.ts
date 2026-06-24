import { describe, expect, it } from "vitest";
import { GENERAL_ACCOUNT_EMAIL, inventoryLocationNameForBoxAssignment, isShiftOrderRoutable } from "./orderRouting";

describe("CSR order routing eligibility", () => {
  it("ignores finalized, supervisor-pending, and clocked-out shifts", () => {
    expect(isShiftOrderRoutable({ status: "finalized", clockedOutAt: null, boxAssignmentId: "sales-box-1" })).toBe(false);
    expect(isShiftOrderRoutable({ status: "supervisor_pending", clockedOutAt: null, boxAssignmentId: "sales-box-1" })).toBe(false);
    expect(isShiftOrderRoutable({ status: "active", clockedOutAt: new Date(), boxAssignmentId: "sales-box-1" })).toBe(false);
  });

  it("selects active clocked-in shifts with a box assignment", () => {
    expect(isShiftOrderRoutable({ status: "active", clockedOutAt: null, boxAssignmentId: "sales-box-1" })).toBe(true);
  });

  it("requires a box assignment before a shift can receive orders", () => {
    expect(isShiftOrderRoutable({ status: "active", clockedOutAt: null, boxAssignmentId: null })).toBe(false);
    expect(isShiftOrderRoutable({ status: "active", clockedOutAt: null, boxAssignmentId: "" })).toBe(false);
  });

  it("maps the assigned shift box_assignment_id to the correct inventory location name", () => {
    expect(inventoryLocationNameForBoxAssignment("sales-box-1")).toBe("CSR Sales Box 1");
    expect(inventoryLocationNameForBoxAssignment("sales-box-2")).toBe("CSR Sales Box 2");
  });

  it("keeps no-active-shift fallback orders in the default info@adiken.com queue", () => {
    expect(GENERAL_ACCOUNT_EMAIL).toBe("info@adiken.com");
  });
});
