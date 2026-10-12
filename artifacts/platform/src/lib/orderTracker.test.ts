import { describe, expect, it } from "vitest";
import { customerTracker } from "./orderTracker";

const placed = "2026-10-06T12:00:00Z";
const eta = "2026-10-06T12:30:00Z";
const order = { createdAt: placed, estimatedReadyAt: eta, status: "submitted", fulfillmentStatus: "in_progress" };

describe("customer order tracker", () => {
  it("derives estimated phases from createdAt, never reassignment time", () => {
    expect(customerTracker({ ...order, routedAt: "2026-10-06T12:25:00Z" }, Date.parse("2026-10-06T12:22:00Z")).phase).toBe("packaging");
    expect(customerTracker(order, Date.parse("2026-10-06T12:03:00Z")).phase).toBe("preparing");
  });
  it("shows finishing up after ETA without claiming staff marked Ready", () => {
    const result = customerTracker(order, Date.parse("2026-10-06T12:31:00Z"));
    expect(result.phase).toBe("overdue");
    expect(result.label).toMatch(/Finishing up/);
    expect(result.label).not.toMatch(/Ready for pickup/);
  });
  it("shows ready only after an authoritative Ready state or readyAt", () => {
    expect(customerTracker({ ...order, readyAt: "2026-10-06T12:20:00Z" }, Date.parse("2026-10-06T12:21:00Z")).phase).toBe("ready");
    expect(customerTracker({ ...order, fulfillmentStatus: "ready" }, Date.parse("2026-10-06T12:21:00Z")).phase).toBe("ready");
  });
});
