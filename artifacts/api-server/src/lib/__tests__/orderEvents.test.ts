import { describe, expect, it } from "vitest";
import { publishOrderEvent, shouldDeliver, getRecentEventsForClient, type SseClient } from "../orderEvents";

function client(userId: number, role: string): SseClient {
  return { userId, role, res: { write: () => true } as never };
}

describe("order event authorization and recovery", () => {
  it("isolates customer events to the order owner", () => {
    const ev = { type: "order.updated" as const, orderId: 1, customerId: 10, assignedCsrUserId: 20, fulfillmentStatus: "ready", status: "ready", estimatedReadyAt: null, acceptedAt: null, etaAdjustedBySupervisor: false, routeSource: "active_csr", reason: "ready" };
    expect(shouldDeliver(client(10, "user"), ev)).toBe(true);
    expect(shouldDeliver(client(11, "user"), ev)).toBe(false);
  });

  it("isolates CSR events to assigned orders and the general queue", () => {
    const assigned = { type: "order.updated" as const, orderId: 1, customerId: 10, assignedCsrUserId: 20, fulfillmentStatus: "ready", status: "ready", estimatedReadyAt: null, acceptedAt: null, etaAdjustedBySupervisor: false, routeSource: "active_csr", reason: "ready" };
    const general = { ...assigned, orderId: 2, assignedCsrUserId: null };
    expect(shouldDeliver(client(20, "csr"), assigned)).toBe(true);
    expect(shouldDeliver(client(21, "csr"), assigned)).toBe(false);
    expect(shouldDeliver(client(21, "csr"), general)).toBe(true);
  });

  it("adds event ids for reconnect de-duplication", () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    publishOrderEvent({ type: "order.updated", orderId: 9999, customerId: 44, assignedCsrUserId: null, fulfillmentStatus: "preparing", status: "preparing", estimatedReadyAt: null, acceptedAt: null, etaAdjustedBySupervisor: false, routeSource: "general_account", reason: "fulfillment_changed" });
    const [ev] = getRecentEventsForClient(client(44, "user"), since).filter((item) => item.orderId === 9999);
    expect(ev?.eventId).toMatch(/^order\.updated:9999:/);
  });
});
