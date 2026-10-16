import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Order = { id: number; tenantId: number; status: string; marker: string };
type Related = { id: number; orderId: number; marker: string };
type Notification = { id: number; tenantId: number; isRead: boolean; marker: string };

let actor: { id: number; role: string; tenantId: number | null; status: string } | null;
let authenticated: boolean;
let recentAuth: boolean;
let orders: Order[];
let notes: Related[];
let items: Related[];
let notifications: Notification[];
const audits: Array<Record<string, unknown>> = [];

vi.mock("../../lib/auth", () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return {
    requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => authenticated ? next() : res.status(401).json({ error: "Authentication required" }),
    loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as express.Request & { dbUser?: unknown }).dbUser = actor; next(); },
    requireDbUser: pass,
    requireApproved: (req: express.Request, res: express.Response, next: express.NextFunction) => actor?.status === "approved" ? next() : res.status(403).json({ error: "Account pending approval" }),
    requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const role = actor?.role === "tenant_admin" ? "admin" : actor?.role;
      return role && (roles.includes(role) || (role === "global_admin" && roles.includes("admin"))) ? next() : res.status(403).json({ error: "Forbidden" });
    },
    requireRecentOwnerAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => recentAuth ? next() : res.status(403).json({ error: "Recent authentication required" }),
    generateSecret: vi.fn(), generateURI: vi.fn(), verifySync: vi.fn(),
  };
});

vi.mock("@workspace/db", () => {
  const tables = {
    tenantsTable: {}, ordersTable: { id: "order.id", status: "order.status" },
    orderItemsTable: { orderId: "item.orderId" }, orderNotesTable: { orderId: "note.orderId" },
    notificationsTable: { id: "notification.id", isRead: "notification.isRead" },
    onboardingRequestsTable: {}, auditLogsTable: {}, usersTable: {},
  };
  const remove = (table: unknown) => ({
    where: (condition: { field: string; value: unknown }) => {
      const rows = table === tables.orderNotesTable ? notes : table === tables.orderItemsTable ? items : table === tables.ordersTable ? orders : notifications;
      const removed = rows.filter((row) => condition.field.endsWith("orderId") ? condition.value instanceof Array && condition.value.includes((row as Related).orderId) : condition.field === "order.id" ? condition.value instanceof Array && condition.value.includes((row as Order).id) : condition.field.endsWith("isRead") ? (row as Notification).isRead === condition.value : false);
      if (table === tables.orderNotesTable) notes = notes.filter((row) => !removed.includes(row));
      else if (table === tables.orderItemsTable) items = items.filter((row) => !removed.includes(row));
      else if (table === tables.ordersTable) orders = orders.filter((row) => !removed.includes(row));
      else notifications = notifications.filter((row) => !removed.includes(row));
      return { returning: async () => removed };
    },
  });
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      select: () => ({ from: () => ({ where: async () => orders.filter((row) => !["delivered", "cancelled"].includes(row.status)).map(({ id }) => ({ id })) }) }),
      delete: remove,
      insert: (table: unknown) => ({ values: async (row: Record<string, unknown>) => { if (table === tables.auditLogsTable) audits.push(row); } }),
    }),
  };
  return { ...tables, db };
});

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown) => ({ field, value }),
  inArray: (field: string, value: unknown) => ({ field, value }),
  notInArray: (_field: string, value: unknown) => ({ field: "order.status", value }),
  count: vi.fn(), desc: vi.fn(),
}));

async function app() {
  const { default: router } = await import("../admin");
  const server = express();
  server.use(express.json());
  server.use("/api", router);
  return server;
}

const before = () => JSON.stringify({ orders, notes, items, notifications });

beforeEach(() => {
  vi.resetModules();
  actor = { id: 1, role: "tenant_admin", tenantId: 10, status: "approved" };
  authenticated = true;
  recentAuth = true;
  orders = [
    { id: 1, tenantId: 10, status: "pending", marker: "tenant-one-order" },
    { id: 2, tenantId: 20, status: "pending", marker: "tenant-two-order" },
    { id: 3, tenantId: 20, status: "delivered", marker: "delivered-order" },
  ];
  notes = [{ id: 11, orderId: 1, marker: "note-one" }, { id: 12, orderId: 2, marker: "note-two" }];
  items = [{ id: 21, orderId: 1, marker: "item-one" }, { id: 22, orderId: 2, marker: "item-two" }];
  notifications = [{ id: 31, tenantId: 10, isRead: false, marker: "unread-one" }, { id: 32, tenantId: 20, isRead: false, marker: "unread-two" }, { id: 33, tenantId: 20, isRead: true, marker: "read-two" }];
  audits.length = 0;
});

describe("platform purge authorization", () => {
  it("denies tenant_admin without changing any tenant's records", async () => {
    const initial = before();
    const response = await supertest(await app()).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" });
    expect(response.status).toBe(403);
    expect(before()).toBe(initial);
  });

  it("denies ordinary, unapproved, and unauthenticated actors without mutation", async () => {
    const server = await app();
    actor = { id: 2, role: "user", tenantId: 10, status: "approved" };
    expect((await supertest(server).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" })).status).toBe(403);
    actor = { id: 2, role: "global_admin", tenantId: null, status: "pending" };
    expect((await supertest(server).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" })).status).toBe(403);
    authenticated = false;
    expect((await supertest(server).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" })).status).toBe(401);
    expect(orders).toHaveLength(3);
    expect(notifications).toHaveLength(3);
  });

  it("requires recent authentication for global_admin", async () => {
    actor = { id: 99, role: "global_admin", tenantId: null, status: "approved" };
    recentAuth = false;
    const initial = before();
    const response = await supertest(await app()).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" });
    expect(response.status).toBe(403);
    expect(before()).toBe(initial);
  });

  it("rejects invalid confirmation and unknown fields", async () => {
    actor = { id: 99, role: "global_admin", tenantId: null, status: "approved" };
    const server = await app();
    const initial = before();
    expect((await supertest(server).post("/api/admin/purge").send({ confirm: "wrong" })).status).toBe(400);
    expect((await supertest(server).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS", tenantId: 20 })).status).toBe(400);
    expect(before()).toBe(initial);
  });

  it("lets global_admin purge only active orders and unread notifications and records a safe audit", async () => {
    actor = { id: 99, role: "global_admin", tenantId: null, status: "approved" };
    const response = await supertest(await app()).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ purged: true, ordersDeleted: 2, notificationsDeleted: 2 });
    expect(orders).toEqual([{ id: 3, tenantId: 20, status: "delivered", marker: "delivered-order" }]);
    expect(notes).toEqual([]);
    expect(items).toEqual([]);
    expect(notifications).toEqual([{ id: 33, tenantId: 20, isRead: true, marker: "read-two" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: 99, actorEmail: "", actorRole: "global_admin", action: "EMERGENCY_PURGE", tenantId: null, resourceType: "platform", resourceId: "all", metadata: { scope: "platform", purgedOrderCount: 2, purgedNotificationCount: 2 } });
    expect(JSON.stringify(audits[0])).not.toMatch(/token|secret|@/i);
  });
});
