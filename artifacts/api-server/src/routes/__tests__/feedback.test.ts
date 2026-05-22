/**
 * Feedback module RBAC + workflow tests.
 *
 * Covers:
 *  - any approved user can POST /api/feedback
 *  - regular users cannot read another user's ticket (GET by id -> 403)
 *  - regular users only see their own tickets in the list
 *  - admin can list every ticket and PATCH status / priority / assignee
 *  - non-admin actors are blocked from PATCH (403)
 *  - status change writes a notification row for the original submitter
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

// `vi.mock` factories are hoisted above `let` declarations, so any state
// the factories close over must live inside `vi.hoisted` to be initialised
// in time. Keep these in one block for readability.
const hoisted = vi.hoisted(() => {
  const state = { mockUserId: "actor-clerk-id" };
  return { state };
});
const setMockUserId = (id: string) => { hoisted.state.mockUserId = id; };

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({ userId: hoisted.state.mockUserId, sessionClaims: undefined }),
  clerkClient: { users: { updateUserMetadata: vi.fn() } },
}));

vi.mock("../../lib/clerkSync", () => ({
  readClerkPublicMetadata: () => ({}),
}));

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn(async () => 1),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface UserRow {
  id: number; clerkId: string; email: string | null; firstName: string | null;
  lastName: string | null; role: string; status: string; isActive: boolean;
  contactPhone: string | null; mfaEnabled: boolean;
  createdAt: Date; updatedAt: Date;
}

const hoistedDb = vi.hoisted(() => {
  interface URow { id: number; clerkId: string; email: string | null; firstName: string | null;
    lastName: string | null; role: string; status: string; isActive: boolean;
    contactPhone: string | null; mfaEnabled: boolean; createdAt: Date; updatedAt: Date; }
  interface TRow { id: number; tenantId: number | null; submitterId: number;
    type: string; severity: string; status: string; priority: boolean;
    title: string; description: string;
    pageUrl: string | null; userAgent: string | null; screenshotData: string | null;
    assigneeId: number | null; createdAt: Date; updatedAt: Date; }
  interface CRow { id: number; ticketId: number; authorId: number;
    body: string; isInternal: boolean; createdAt: Date; }
  interface NRow { id: number; userId: number; type: string;
    title: string; message: string; isRead: boolean;
    resourceType: string | null; resourceId: number | null; createdAt: Date; }

  const state = {
    users: [] as URow[],
    tickets: [] as TRow[],
    comments: [] as CRow[],
    notifications: [] as NRow[],
    audits: [] as { id: number; actorId: number; action: string }[],
    nextTicketId: 1,
    nextCommentId: 1,
    nextNotificationId: 1,
    nextAuditId: 1,
  };

  function makeCol<T extends string>(name: T) { return { _name: name } as { _name: T }; }
  const usersTable = { id: makeCol("id"), clerkId: makeCol("clerkId"), email: makeCol("email"),
    role: makeCol("role"), status: makeCol("status") };
  const feedbackTicketsTable = { id: makeCol("id"), tenantId: makeCol("tenantId"),
    submitterId: makeCol("submitterId"), type: makeCol("type"), status: makeCol("status"),
    priority: makeCol("priority"), assigneeId: makeCol("assigneeId"), createdAt: makeCol("createdAt") };
  const feedbackTicketCommentsTable = { id: makeCol("id"), ticketId: makeCol("ticketId"),
    createdAt: makeCol("createdAt") };
  const notificationsTable = { id: makeCol("id") };
  const auditLogsTable = { id: makeCol("id") };

  type Pred = Record<string, unknown> & { op?: string };
  function evalRow(row: Record<string, unknown>, pred?: Pred): boolean {
    if (!pred) return true;
    if (pred.op === "and") return (pred.conds as Pred[]).every((c) => evalRow(row, c));
    if (pred.op === "in") {
      const colName = (pred.col as { _name?: string })._name as string;
      return (pred.values as unknown[]).includes(row[colName]);
    }
    if (pred.op === "gte") {
      const colName = (pred.col as { _name?: string })._name as string;
      return new Date(row[colName] as Date | string).getTime() >= new Date(pred.val as Date | string).getTime();
    }
    if (pred.op === "lte") {
      const colName = (pred.col as { _name?: string })._name as string;
      return new Date(row[colName] as Date | string).getTime() <= new Date(pred.val as Date | string).getTime();
    }
    if (pred.op === "eq") {
      const colName = (pred.col as { _name?: string })._name as string;
      return row[colName] === pred.val;
    }
    return true;
  }

  function tableForName(t: unknown): keyof typeof state | null {
    if (t === usersTable) return "users";
    if (t === feedbackTicketsTable) return "tickets";
    if (t === feedbackTicketCommentsTable) return "comments";
    if (t === notificationsTable) return "notifications";
    if (t === auditLogsTable) return "audits";
    return null;
  }

  const db = {
    execute: vi.fn(() => Promise.resolve()),
    select(_cols?: unknown) {
      let table: keyof typeof state = "tickets";
      let pred: Pred | undefined;
      let _limit: number | undefined;
      const builder = {
        from(t: unknown) { const k = tableForName(t); if (k) table = k; return builder; },
        where(p: Pred) { pred = p; return builder; },
        orderBy(..._args: unknown[]) { return builder; },
        limit(n: number) { _limit = n; return builder; },
        then(resolve: (v: unknown) => unknown) {
          const rows = (state[table] as Record<string, unknown>[])
            .filter((r) => evalRow(r, pred))
            // Shallow-clone so callers can hold a "snapshot" before an
            // update without seeing mutations from the in-place update mock.
            .map((r) => ({ ...r }));
          const out = _limit != null ? rows.slice(0, _limit) : rows;
          return Promise.resolve(out).then(resolve);
        },
      };
      return builder;
    },
    insert(t: unknown) {
      const key = tableForName(t);
      return {
        values(vals: unknown) {
          const arr = Array.isArray(vals) ? vals : [vals];
          const inserted: Record<string, unknown>[] = [];
          for (const v of arr) {
            let row: Record<string, unknown>;
            if (key === "tickets") {
              row = { id: state.nextTicketId++, ...(v as Record<string, unknown>),
                createdAt: new Date(), updatedAt: new Date() };
            } else if (key === "comments") {
              row = { id: state.nextCommentId++, ...(v as Record<string, unknown>), createdAt: new Date() };
            } else if (key === "notifications") {
              row = { id: state.nextNotificationId++, isRead: false,
                ...(v as Record<string, unknown>), createdAt: new Date() };
            } else if (key === "users") {
              row = { ...(v as Record<string, unknown>), createdAt: new Date(), updatedAt: new Date() };
            } else {
              row = { id: state.nextAuditId++, ...(v as Record<string, unknown>) };
            }
            if (key) (state[key] as Record<string, unknown>[]).push(row);
            inserted.push(row);
          }
          return {
            returning: () => Promise.resolve(inserted),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(inserted).then(resolve),
          };
        },
      };
    },
    update(t: unknown) {
      const key = tableForName(t);
      let pred: Pred | undefined;
      let setVals: Record<string, unknown> = {};
      const builder = {
        set(v: Record<string, unknown>) { setVals = v; return builder; },
        where(p: Pred) { pred = p; return builder; },
        returning: () => {
          const rows = (state[key as keyof typeof state] as Record<string, unknown>[])
            .filter((r) => evalRow(r, pred));
          rows.forEach((r) => Object.assign(r, setVals));
          return Promise.resolve(rows);
        },
      };
      return builder;
    },
  };

  return { state, db, usersTable, feedbackTicketsTable, feedbackTicketCommentsTable,
    notificationsTable, auditLogsTable };
});

const dbState = hoistedDb.state;

vi.mock("@workspace/db", () => ({
  db: hoistedDb.db,
  usersTable: hoistedDb.usersTable,
  feedbackTicketsTable: hoistedDb.feedbackTicketsTable,
  feedbackTicketCommentsTable: hoistedDb.feedbackTicketCommentsTable,
  notificationsTable: hoistedDb.notificationsTable,
  auditLogsTable: hoistedDb.auditLogsTable,
}));

vi.mock("drizzle-orm", () => ({
  eq:  (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  desc: (col: unknown) => col,
  asc:  (col: unknown) => col,
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  inArray: (col: unknown, values: unknown[]) => ({ op: "in", col, values }),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

import feedbackRouter from "../feedback";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", feedbackRouter);
  return app;
}

function seedUser(id: number, clerkId: string, role: string): UserRow {
  const u: UserRow = {
    id, clerkId, email: `${clerkId}@example.com`, firstName: "F", lastName: "L",
    role, status: "approved", isActive: true, contactPhone: null, mfaEnabled: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
  dbState.users.push(u);
  return u;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.users = [];
  dbState.tickets = [];
  dbState.comments = [];
  dbState.notifications = [];
  dbState.audits = [];
  dbState.nextTicketId = 1;
  dbState.nextCommentId = 1;
  dbState.nextNotificationId = 1;
  dbState.nextAuditId = 1;
});

describe("POST /api/feedback", () => {
  it("creates a ticket for any approved user and notifies all admins", async () => {
    seedUser(1, "actor-clerk-id", "user");
    seedUser(99, "admin1", "admin");
    seedUser(98, "supe", "supervisor");
    setMockUserId("actor-clerk-id");
    const app = buildApp();

    const res = await supertest(app).post("/api/feedback").send({
      type: "bug",
      severity: "high",
      title: "Cart breaks on iOS",
      description: "Tap +, page reloads, cart empties.",
      pageUrl: "https://app.example.com/cart",
      userAgent: "ios-safari",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(res.body.submitterId).toBe(1);
    expect(res.body.status).toBe("new");
    expect(res.body.priority).toBe(false);

    // Both admin + supervisor get notified.
    const notifiedIds = dbState.notifications.map((n) => n.userId).sort();
    expect(notifiedIds).toEqual([98, 99]);
    expect(dbState.notifications.every((n) => n.type === "feedback_new")).toBe(true);
  });

  it("rejects payload that fails validation", async () => {
    seedUser(1, "actor-clerk-id", "user");
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp())
      .post("/api/feedback")
      .send({ type: "bogus", title: "x", description: "y" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/feedback (RBAC)", () => {
  it("regular user only sees their own tickets", async () => {
    seedUser(1, "actor-clerk-id", "user");
    seedUser(2, "other-user", "user");
    seedUser(99, "admin1", "admin");
    // Pre-existing tickets from other people.
    dbState.tickets.push(
      { id: 10, tenantId: 1, submitterId: 2, type: "bug", severity: "low", status: "new",
        priority: false, title: "not yours", description: "x", pageUrl: null, userAgent: null,
        screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 11, tenantId: 1, submitterId: 1, type: "ux", severity: "low", status: "new",
        priority: false, title: "yours", description: "x", pageUrl: null, userAgent: null,
        screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date() },
    );
    dbState.nextTicketId = 12;
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/feedback");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { id: number }) => t.id)).toEqual([11]);
  });

  it("admin sees every ticket", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    seedUser(2, "other-user", "user");
    dbState.tickets.push(
      { id: 10, tenantId: 1, submitterId: 2, type: "bug", severity: "low", status: "new",
        priority: false, title: "a", description: "x", pageUrl: null, userAgent: null,
        screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 11, tenantId: 1, submitterId: 1, type: "ux", severity: "low", status: "new",
        priority: false, title: "b", description: "x", pageUrl: null, userAgent: null,
        screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date() },
    );
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/feedback");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { id: number }) => t.id).sort()).toEqual([10, 11]);
  });
});

describe("GET /api/feedback/:id (RBAC)", () => {
  it("blocks a regular user from reading someone else's ticket", async () => {
    seedUser(1, "actor-clerk-id", "user");
    seedUser(2, "other-user", "user");
    dbState.tickets.push({
      id: 7, tenantId: 1, submitterId: 2, type: "bug", severity: "low", status: "new",
      priority: false, title: "private", description: "x", pageUrl: null, userAgent: null,
      screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/feedback/7");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/feedback/:id", () => {
  it("admin can change status, and submitter is notified", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    seedUser(2, "submitter", "user");
    dbState.tickets.push({
      id: 5, tenantId: 1, submitterId: 2, type: "bug", severity: "high", status: "new",
      priority: false, title: "broken", description: "x", pageUrl: null, userAgent: null,
      screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp())
      .patch("/api/feedback/5")
      .send({ status: "in_progress", priority: true, assigneeId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.priority).toBe(true);
    expect(res.body.assigneeId).toBe(1);

    // Submitter (user 2) gets a feedback_status notification.
    const submitterNotes = dbState.notifications.filter((n) => n.userId === 2);
    expect(submitterNotes.length).toBe(1);
    expect(submitterNotes[0].type).toBe("feedback_status");
  });

  it("blocks a regular user with 403", async () => {
    seedUser(1, "actor-clerk-id", "user");
    dbState.tickets.push({
      id: 5, tenantId: 1, submitterId: 1, type: "bug", severity: "high", status: "new",
      priority: false, title: "broken", description: "x", pageUrl: null, userAgent: null,
      screenshotData: null, assigneeId: null, createdAt: new Date(), updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp())
      .patch("/api/feedback/5")
      .send({ status: "closed" });
    expect(res.status).toBe(403);
  });
});
