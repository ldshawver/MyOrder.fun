import { describe, expect, it } from "vitest";
import { staffFulfillmentAction, STAFF_FULFILLMENT_STATUSES, staffVisibleFulfillmentState } from "../staffFulfillmentAction";

describe("staff fulfillment action", () => {
  it("offers Start, Packaging, Ready, Complete and displays legacy preparing in progress", () => {
    expect(STAFF_FULFILLMENT_STATUSES).toEqual(["in_progress", "packaging", "ready", "completed"]);
    expect(staffVisibleFulfillmentState("preparing")).toBe("in_progress");
  });
  it("uses the shift-bound claim for a CSR", () => {
    expect(staffFulfillmentAction(48, "in_progress", false)).toEqual({
      endpoint: "/api/orders/48/claim",
      body: {},
    });
  });

  it("uses the authorized fulfillment transition for an admin without a CSR shift", () => {
    expect(staffFulfillmentAction(48, "in_progress", true)).toEqual({
      endpoint: "/api/orders/48/fulfillment",
      body: { fulfillmentStatus: "in_progress" },
    });
  });

  it("keeps later transitions and completion on the server-owned workflow", () => {
    expect(staffFulfillmentAction(48, "preparing", true).endpoint).toBe("/api/orders/48/prepare");
    expect(staffFulfillmentAction(48, "packaging", true).endpoint).toBe("/api/orders/48/packaging");
    expect(staffFulfillmentAction(48, "ready", true).endpoint).toBe("/api/orders/48/ready");
    expect(staffFulfillmentAction(48, "completed", true)).toEqual({ endpoint: "/api/orders/48/complete" });
  });
});
