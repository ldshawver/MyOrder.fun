import { describe, expect, it } from "vitest";
import { customerTracker } from "./orderTracker";

const placed = "2026-10-06T12:00:00Z";
const claimed = "2026-10-06T12:10:00Z";
const eta = "2026-10-06T12:20:00Z";
const order = { createdAt: placed, acceptedAt: claimed, estimatedReadyAt: eta, status: "in_progress", fulfillmentStatus: "in_progress" };

describe("customer order tracker", () => {
  it("starts the preparation estimate at the authoritative claim time", () => {
    expect(customerTracker({ ...order, createdAt: "2026-10-06T11:00:00Z" }, Date.parse("2026-10-06T12:12:00Z")).progress).toBeCloseTo(0.2);
    expect(customerTracker({ ...order, acceptedAt: null }, Date.parse("2026-10-06T12:12:00Z")).remainingMs).toBeNull();
    expect(customerTracker({ ...order, fulfillmentStatus: "packaging" }, Date.parse("2026-10-06T12:12:00Z")).phase).toBe("packaging");
  });
  it("shows finishing up after ETA without claiming staff marked Ready", () => {
    const result = customerTracker(order, Date.parse("2026-10-06T12:31:00Z"));
    expect(result.phase).toBe("overdue");
    expect(result.label).toMatch(/taking longer than estimated/i);
    expect(result.label).not.toMatch(/Ready for pickup/);
  });
  it("shows ready only after an authoritative Ready state or readyAt", () => {
    expect(customerTracker({ ...order, readyAt: "2026-10-06T12:20:00Z" }, Date.parse("2026-10-06T12:21:00Z")).phase).toBe("ready");
    expect(customerTracker({ ...order, fulfillmentStatus: "ready" }, Date.parse("2026-10-06T12:21:00Z")).phase).toBe("ready");
  });

  it("does not infer packaging from the countdown reaching a percentage", () => {
    expect(customerTracker(order, Date.parse("2026-10-06T12:18:00Z")).phase).toBe("preparing");
  });
});
