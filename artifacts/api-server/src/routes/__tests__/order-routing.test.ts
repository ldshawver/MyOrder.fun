/**
 * Task #12 — Order routing & SSE event bus tests.
 *
 * Spec vocabulary:
 *   routing rules:  round_robin (default) | least_recent_order | supervisor_manual_assignment
 *   route_source:   active_csr | general_account | supervisor_override
 *   events:         order.assigned | order.updated | order.ready
 *
 * Coverage:
 *  - decideRouting → general_account fallback when no active CSR
 *  - decideRouting → active_csr with assignedShiftId for the picked CSR
 *  - round_robin distributes to the CSR with the oldest routedAt
 *  - supervisor_manual_assignment never auto-routes
 *  - default ETA of 30 minutes from admin_settings.defaultEtaMinutes
 *  - supervisor ETA adjustment emits order.updated with etaAdjustedBySupervisor=true
 *  - SSE filters: admin (all), CSR (own + null fallback), customer (own customerId)
 *  - reassignOrder rejects targets that are not currently active CSRs
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const adminSettings = { orderRoutingRule: "round_robin", defaultEtaMinutes: 30 };
let activeCsrUsers: Array<{ userId: number; shiftId: number; role: string }> = [];
let routedStats: Array<{ userId: number; last: Date | null }> = [];
let acceptedStats: Array<{ userId: number; last: Date | null }> = [];
let existingOrderState: { f: string | null; s: string | null } | null = null;
let lastReassignUpdateSet: Record<string, unknown> | null = null;

vi.mock("@workspace/db", () => {
  const tables = {
    adminSettingsTable: { __t: "admin_settings" },
    usersTable: { __t: "users", id: "users.id", role: "users.role" },
    labTechShiftsTable: { __t: "lab_tech_shifts", id: "shifts.id", techId: "shifts.techId", status: "shifts.status" },
    ordersTable: {
      __t: "orders",
      id: "orders.id",
      assignedCsrUserId: "orders.assignedCsrUserId",
      routedAt: "orders.routedAt",
      acceptedAt: "orders.acceptedAt",
      routeSource: "orders.routeSource",
    },
  };

  function chain(rows: unknown[]) {
    const p = Promise.resolve(rows) as unknown as Record<string, unknown>;
    p.limit = vi.fn(() => Promise.resolve(rows));
    p.where = vi.fn(() => chain(rows));
    p.from = vi.fn((table: { __t: string }) => {
      if (table.__t === "admin_settings") return chain([adminSettings]);
      if (table.__t === "lab_tech_shifts") return chain([]);
      if (table.__t === "orders") return chain([]);
      return chain([]);
    });
    p.innerJoin = vi.fn(() => chain(activeCsrUsers));
    p.groupBy = vi.fn(() => Promise.resolve(routedStats));
    p.orderBy = vi.fn(() => Promise.resolve(rows));
    return p;
  }

  const db = {
    select: vi.fn((cols?: Record<string, unknown>) => {
      if (cols && "userId" in cols && "last" in cols) {
        const stats = adminSettings.orderRoutingRule === "least_recent_order"
          ? acceptedStats : routedStats;
        const c = chain([]);
        c.from = vi.fn(() => c);
        c.where = vi.fn(() => c);
        c.groupBy = vi.fn(() => Promise.resolve(stats));
        return c;
      }
      if (cols && "f" in cols && "s" in cols) {
        const rows = existingOrderState ? [existingOrderState] : [];
        const c = chain(rows);
        c.from = vi.fn(() => c);
        c.where = vi.fn(() => c);
        c.limit = vi.fn(() => Promise.resolve(rows));
        return c;
      }
      return chain([]);
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: () => Promise.resolve([{ id: 1 }]) })) })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        lastReassignUpdateSet = vals;
        return {
          where: vi.fn(() => ({ returning: () => Promise.resolve([{ id: 1, assignedCsrUserId: 7, routeSource: "supervisor_override", ...vals }]) })),
        };
      }),
    })),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn((...a) => a),
  asc: vi.fn((c) => c),
  desc: vi.fn((c) => c),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { decideRouting, reassignOrder } from "../../lib/orderRouting";
import { publishOrderEvent, subscribe, _resetBus } from "../../lib/orderEvents";

beforeEach(() => {
  activeCsrUsers = [];
  routedStats = [];
  acceptedStats = [];
  adminSettings.orderRoutingRule = "round_robin";
  adminSettings.defaultEtaMinutes = 30;
  _resetBus();
});

describe("decideRouting", () => {
  it("falls back to General Account (assignedCsrUserId=null, route_source=general_account)", async () => {
    activeCsrUsers = [];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBeNull();
    expect(r.assignedShiftId).toBeNull();
    expect(r.routeSource).toBe("general_account");
    // Default 30-minute hourglass
    expect(r.promisedMinutes).toBe(30);
    expect(r.estimatedReadyAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(r.estimatedReadyAt.getTime()).toBeLessThan(Date.now() + 35 * 60_000);
  });

  it("uses defaultEtaMinutes from admin_settings (override of the 30-min default)", async () => {
    adminSettings.defaultEtaMinutes = 90;
    activeCsrUsers = [];
    const r = await decideRouting();
    expect(r.promisedMinutes).toBe(90);
    expect(r.estimatedReadyAt.getTime()).toBeGreaterThan(Date.now() + 85 * 60_000);
  });

  it("routes to the only active CSR with active_csr source + their shiftId", async () => {
    activeCsrUsers = [{ userId: 42, shiftId: 7, role: "customer_service_rep" }];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBe(42);
    expect(r.assignedShiftId).toBe(7);
    expect(r.routeSource).toBe("active_csr");
  });

  it("supervisor_manual_assignment with multiple active CSRs sits in the General Account queue", async () => {
    adminSettings.orderRoutingRule = "supervisor_manual_assignment";
    activeCsrUsers = [
      { userId: 42, shiftId: 7, role: "customer_service_rep" },
      { userId: 43, shiftId: 8, role: "customer_service_rep" },
    ];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBeNull();
    expect(r.routeSource).toBe("general_account");
    expect(r.rule).toBe("supervisor_manual_assignment");
  });

  it("supervisor_manual_assignment with exactly one active CSR still routes to that CSR", async () => {
    adminSettings.orderRoutingRule = "supervisor_manual_assignment";
    activeCsrUsers = [{ userId: 42, shiftId: 7, role: "customer_service_rep" }];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBe(42);
    expect(r.assignedShiftId).toBe(7);
    expect(r.routeSource).toBe("active_csr");
  });

  it("round_robin distributes to the CSR with the oldest max(routedAt) and stamps their shift", async () => {
    activeCsrUsers = [
      { userId: 10, shiftId: 100, role: "customer_service_rep" },
      { userId: 11, shiftId: 101, role: "customer_service_rep" },
      { userId: 12, shiftId: 102, role: "customer_service_rep" },
    ];
    const now = Date.now();
    routedStats = [
      { userId: 10, last: new Date(now - 60_000) },
      { userId: 11, last: new Date(now - 600_000) },
      { userId: 12, last: new Date(now - 300_000) },
    ];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBe(11);
    expect(r.assignedShiftId).toBe(101);
    expect(r.routeSource).toBe("active_csr");
  });

  it("least_recent_order picks the CSR with the oldest acceptedAt", async () => {
    adminSettings.orderRoutingRule = "least_recent_order";
    activeCsrUsers = [
      { userId: 20, shiftId: 200, role: "customer_service_rep" },
      { userId: 21, shiftId: 201, role: "customer_service_rep" },
    ];
    const now = Date.now();
    acceptedStats = [
      { userId: 20, last: new Date(now - 120_000) },
      { userId: 21, last: new Date(now - 999_000) },
    ];
    const r = await decideRouting();
    expect(r.assignedCsrUserId).toBe(21);
  });
});

describe("reassignOrder", () => {
  it("rejects targets that are not currently active CSRs", async () => {
    activeCsrUsers = [{ userId: 7, shiftId: 70, role: "customer_service_rep" }];
    await expect(reassignOrder(1, 999)).rejects.toThrow(/active CSR/);
  });

  it("accepts null (sends order back to General Account queue)", async () => {
    activeCsrUsers = [];
    await expect(reassignOrder(1, null)).resolves.toBeDefined();
  });

  it("preserves terminal status/fulfillment when reassigning a completed order", async () => {
    activeCsrUsers = [];
    existingOrderState = { f: "completed", s: "completed" };
    lastReassignUpdateSet = null;
    await reassignOrder(1, null);
    expect(lastReassignUpdateSet).not.toBeNull();
    expect(lastReassignUpdateSet).not.toHaveProperty("status");
    expect(lastReassignUpdateSet).not.toHaveProperty("fulfillmentStatus");
    expect(lastReassignUpdateSet?.routeSource).toBe("supervisor_override");
  });

  it("resets to submitted/pending when reassigning an in-flight order", async () => {
    activeCsrUsers = [];
    existingOrderState = { f: "accepted", s: "processing" };
    lastReassignUpdateSet = null;
    await reassignOrder(1, null);
    expect(lastReassignUpdateSet?.fulfillmentStatus).toBe("submitted");
    expect(lastReassignUpdateSet?.status).toBe("pending");
  });
});

describe("orderEvents SSE bus", () => {
  function fakeRes() {
    const writes: string[] = [];
    return {
      writes,
      res: {
        write: vi.fn((s: string) => { writes.push(s); return true; }),
      } as unknown as import("express").Response,
    };
  }

  it("delivers order.assigned to admin subscribers (sees everything)", () => {
    const c = fakeRes();
    const teardown = subscribe({ res: c.res, userId: 1, role: "admin" });
    publishOrderEvent({
      type: "order.assigned", orderId: 5, customerId: 200, assignedCsrUserId: 99,
      routeSource: "active_csr", customerName: "X", total: 10, itemCount: 1,
      routedAt: new Date().toISOString(), estimatedReadyAt: new Date().toISOString(),
      promisedMinutes: 30,
    });
    teardown();
    expect(c.writes.join("")).toContain("order.assigned");
    expect(c.writes.join("")).toContain('"orderId":5');
  });

  it("scopes order.assigned for CSR — own assignments + null general queue only", () => {
    const csr = fakeRes();
    const teardown = subscribe({ res: csr.res, userId: 7, role: "customer_service_rep" });
    publishOrderEvent({
      type: "order.assigned", orderId: 10, customerId: 200, assignedCsrUserId: 99,
      routeSource: "active_csr", customerName: "Other", total: 1, itemCount: 1,
      routedAt: "x", estimatedReadyAt: null, promisedMinutes: 30,
    });
    publishOrderEvent({
      type: "order.assigned", orderId: 11, customerId: 201, assignedCsrUserId: 7,
      routeSource: "active_csr", customerName: "Mine", total: 1, itemCount: 1,
      routedAt: "x", estimatedReadyAt: null, promisedMinutes: 30,
    });
    publishOrderEvent({
      type: "order.assigned", orderId: 12, customerId: 202, assignedCsrUserId: null,
      routeSource: "general_account", customerName: "GenQ", total: 1, itemCount: 1,
      routedAt: "x", estimatedReadyAt: null, promisedMinutes: 30,
    });
    teardown();
    const all = csr.writes.join("");
    expect(all).not.toContain('"orderId":10');
    expect(all).toContain('"orderId":11');
    expect(all).toContain('"orderId":12');
  });

  it("scopes events for customers — only their own customerId, never another's", () => {
    const me = fakeRes();
    const teardown = subscribe({ res: me.res, userId: 200, role: "user" });
    publishOrderEvent({
      type: "order.updated", orderId: 50, customerId: 999, assignedCsrUserId: null,
      fulfillmentStatus: "ready", status: "ready", estimatedReadyAt: null,
      acceptedAt: null, etaAdjustedBySupervisor: false, routeSource: "active_csr",
      reason: "status_changed",
    });
    publishOrderEvent({
      type: "order.ready", orderId: 51, customerId: 200, assignedCsrUserId: 7,
      readyAt: new Date().toISOString(),
    });
    // Hourglass extension by supervisor for my own order — must be delivered
    // and must include the etaAdjustedBySupervisor=true flag
    publishOrderEvent({
      type: "order.updated", orderId: 52, customerId: 200, assignedCsrUserId: 7,
      fulfillmentStatus: "accepted", status: "processing",
      estimatedReadyAt: new Date(Date.now() + 45 * 60_000).toISOString(),
      acceptedAt: new Date().toISOString(), etaAdjustedBySupervisor: true,
      routeSource: "active_csr", reason: "eta_adjusted",
    });
    teardown();
    const all = me.writes.join("");
    expect(all).not.toContain('"orderId":50');
    expect(all).toContain('"orderId":51');
    expect(all).toContain('"orderId":52');
    expect(all).toContain('"etaAdjustedBySupervisor":true');
  });

  it("clearance event for prior CSR on CSR->CSR reassignment is delivered to that prior CSR", () => {
    // Simulates the scoped event the /reassign route emits to the
    // previous assignee so their CsrAlertBanner can drop the stale
    // alert card.
    const prior = fakeRes();
    const teardownPrior = subscribe({ res: prior.res, userId: 7, role: "customer_service_rep" });
    const next = fakeRes();
    const teardownNext = subscribe({ res: next.res, userId: 8, role: "customer_service_rep" });
    publishOrderEvent({
      type: "order.updated", orderId: 77, customerId: 300,
      assignedCsrUserId: 7,
      fulfillmentStatus: "submitted", status: "pending",
      estimatedReadyAt: null, acceptedAt: null,
      etaAdjustedBySupervisor: false, routeSource: "supervisor_override",
      reason: "reassigned",
    });
    teardownPrior(); teardownNext();
    expect(prior.writes.join("")).toContain('"orderId":77');
    expect(prior.writes.join("")).toContain('"reason":"reassigned"');
    expect(next.writes.join("")).not.toContain('"orderId":77');
  });

  it("teardown removes the listener (no further writes)", () => {
    const c = fakeRes();
    const teardown = subscribe({ res: c.res, userId: 1, role: "admin" });
    teardown();
    publishOrderEvent({
      type: "order.ready", orderId: 1, customerId: 1, assignedCsrUserId: null,
      readyAt: new Date().toISOString(),
    });
    expect(c.writes.length).toBe(0);
  });
});
