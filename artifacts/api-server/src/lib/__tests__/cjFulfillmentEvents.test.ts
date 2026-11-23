import { describe, expect, it } from "vitest";
import { decideCjEventTransition, groupStatusForCjProviderStatus, parseCjProviderEvent } from "../cjFulfillmentEvents";

describe("CJ fulfillment event policy", () => {
  it("accepts only a bounded strict provider event", () => {
    expect(parseCjProviderEvent({
      eventId: "evt-1", eventType: "ORDER_STATUS", providerOrderId: "cj-1",
      status: "processing", occurredAt: "2026-11-23T12:00:00Z",
    })).toMatchObject({ eventId: "evt-1", status: "processing", occurredAt: new Date("2026-11-23T12:00:00Z") });
    expect(() => parseCjProviderEvent({ eventId: "evt-1", eventType: "x", providerOrderId: "cj-1", status: "unknown" })).toThrow();
    expect(() => parseCjProviderEvent({ eventId: "evt-1", eventType: "x", providerOrderId: "cj-1", status: "pending", tenantId: 7 })).toThrow();
  });

  it("maps provider states without granting staff-style intermediate authority", () => {
    expect(groupStatusForCjProviderStatus("pending")).toBe("submitted");
    expect(groupStatusForCjProviderStatus("processing")).toBe("preparing");
    expect(groupStatusForCjProviderStatus("completed")).toBe("completed");
    expect(groupStatusForCjProviderStatus("cancelled")).toBe("cancelled");
    expect(groupStatusForCjProviderStatus("refunded")).toBe("refunded");
    expect(groupStatusForCjProviderStatus("on_hold")).toBe("reconciliation_required");
    expect(groupStatusForCjProviderStatus("failed")).toBe("reconciliation_required");
  });

  it("applies forward progress and permits a completed order to be refunded", () => {
    expect(decideCjEventTransition({ currentProviderStatus: "pending", incomingProviderStatus: "processing", lastProviderEventAt: null, incomingProviderEventAt: null }))
      .toEqual({ action: "apply", providerStatus: "processing", groupStatus: "preparing" });
    expect(decideCjEventTransition({ currentProviderStatus: "completed", incomingProviderStatus: "refunded", lastProviderEventAt: null, incomingProviderEventAt: null }))
      .toEqual({ action: "apply", providerStatus: "refunded", groupStatus: "refunded" });
  });

  it("is idempotent for repeated state and escalates stale, regressive, or conflicting terminal events", () => {
    expect(decideCjEventTransition({ currentProviderStatus: "processing", incomingProviderStatus: "processing", lastProviderEventAt: null, incomingProviderEventAt: null })).toEqual({ action: "idempotent" });
    expect(decideCjEventTransition({ currentProviderStatus: "processing", incomingProviderStatus: "pending", lastProviderEventAt: null, incomingProviderEventAt: null })).toEqual({ action: "reconcile", reason: "provider_status_conflict" });
    expect(decideCjEventTransition({ currentProviderStatus: "completed", incomingProviderStatus: "cancelled", lastProviderEventAt: null, incomingProviderEventAt: null })).toEqual({ action: "reconcile", reason: "provider_status_conflict" });
    expect(decideCjEventTransition({ currentProviderStatus: "processing", incomingProviderStatus: "completed", lastProviderEventAt: new Date("2026-11-23T12:00:00Z"), incomingProviderEventAt: new Date("2026-11-23T11:59:59Z") })).toEqual({ action: "reconcile", reason: "stale_event" });
  });
});
