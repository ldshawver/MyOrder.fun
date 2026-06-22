import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@clerk/express", () => ({ clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), getAuth: vi.fn(() => ({ userId: "user-clerk-id" })) }));
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, tenantId: 1, role: "admin", status: "approved", email: "a@b.com", clerkId: "user-clerk-id" }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column: string, value: unknown) => ({ op: "eq", column, value })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  desc: vi.fn((column: unknown) => ({ op: "desc", column })),
}));

const state: { notifications: Array<Record<string, unknown>> } = { notifications: [] };

vi.mock("@workspace/db", () => {
  const notificationsTable = { id: "id", userId: "userId", createdAt: "createdAt", isRead: "isRead" };
  const applyWhere = (rows: Array<Record<string, unknown>>, cond: unknown): Array<Record<string, unknown>> => {
    if (!cond || typeof cond !== "object") return rows;
    const c = cond as { op?: string; args?: unknown[]; column?: string; value?: unknown };
    if (c.op === "and") return (c.args ?? []).reduce((acc, next) => applyWhere(acc, next), rows);
    if (c.op === "eq" && c.column) return rows.filter(row => row[c.column!] === c.value);
    return rows;
  };
  const query = (rows: Array<Record<string, unknown>>) => ({
    where: (cond: unknown) => query(applyWhere(rows, cond)),
    orderBy: () => Promise.resolve([...rows].sort((a, b) => Number(b.id) - Number(a.id))),
    limit: () => Promise.resolve(rows.slice(0, 1)),
    then: (resolve: (value: unknown) => void) => resolve(rows),
  });
  return { notificationsTable, db: {
    select: vi.fn(() => ({ from: () => query(state.notifications) })),
    update: vi.fn(() => ({ set: (patch: Record<string, unknown>) => ({ where: (cond: unknown) => ({ returning: () => {
      const rows = applyWhere(state.notifications, cond);
      if (rows[0]) Object.assign(rows[0], patch);
      return Promise.resolve(rows.slice(0, 1));
    } }) }) })),
  } };
});

const notificationsRouter = (await import("../notifications")).default;
function buildApp() { const app = express(); app.use(express.json()); app.use("/api", notificationsRouter); return app; }

beforeEach(() => {
  state.notifications = [
    { id: 1, userId: 1, type: "feedback_new", title: "Feedback", message: "New feedback", isRead: false, resourceType: "feedback_ticket", resourceId: 10, createdAt: new Date("2026-06-01T00:00:00Z") },
    { id: 2, userId: 1, type: "account_approved", title: "Approved", message: "Account approved", isRead: false, resourceType: "user", resourceId: 1, createdAt: new Date("2026-06-02T00:00:00Z") },
    { id: 3, userId: 1, type: "future_type", title: "Future", message: "Unknown type", isRead: false, resourceType: null, resourceId: null, createdAt: new Date("2026-06-03T00:00:00Z") },
  ];
});

describe("notifications route", () => {
  it("returns 200 for feedback_new/account_approved records and maps unknown future types safely", async () => {
    const res = await supertest(buildApp()).get("/api/notifications");

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "feedback_new" }),
      expect.objectContaining({ type: "account_approved" }),
      expect.objectContaining({ type: "admin_alert", title: "Future" }),
    ]));
    expect(res.body.unreadCount).toBe(3);
  });
});
