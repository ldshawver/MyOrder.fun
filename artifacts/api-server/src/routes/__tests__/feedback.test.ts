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
const setMockUserId = (id: string) => {
  hoisted.state.mockUserId = id;
};

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({
    userId: hoisted.state.mockUserId,
    sessionClaims: undefined,
  }),
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
  id: number;
  clerkId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  status: string;
  isActive: boolean;
  contactPhone: string | null;
  mfaEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const hoistedDb = vi.hoisted(() => {
  interface URow {
    id: number;
    clerkId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    role: string;
    status: string;
    isActive: boolean;
    contactPhone: string | null;
    mfaEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }
  interface TRow {
    id: number;
    tenantId: number | null;
    submitterId: number;
    submitterRole?: string;
    type: string;
    severity: string;
    status: string;
    priority: boolean;
    title: string;
    description: string;
    pageUrl: string | null;
    userAgent: string | null;
    screenshotData: string | null;
    assigneeId: number | null;
    reviewedAt?: Date | null;
    reviewedByUserId?: number | null;
    archivedAt?: Date | null;
    archivedByUserId?: number | null;
    ticketId?: string | null;
    contextJson?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }
  interface CRow {
    id: number;
    ticketId: number;
    authorId: number;
    body: string;
    isInternal: boolean;
    createdAt: Date;
  }
  interface NRow {
    id: number;
    userId: number;
    type: string;
    title: string;
    message: string;
    isRead: boolean;
    resourceType: string | null;
    resourceId: number | null;
    createdAt: Date;
  }

  const state = {
    users: [] as URow[],
    tickets: [] as TRow[],
    comments: [] as CRow[],
    notifications: [] as NRow[],
    settings: [] as {
      id: number;
      tenantId: number;
      feedbackArchiveReviewedAfterDays: number | null;
      feedbackArchiveUnreadAfterDays: number | null;
      feedbackArchiveUnreadEnabled: boolean;
    }[],
    audits: [] as { id: number; actorId: number; action: string }[],
    nextTicketId: 1,
    nextCommentId: 1,
    nextNotificationId: 1,
    nextAuditId: 1,
  };

  function makeCol<T extends string>(name: T) {
    return { _name: name } as { _name: T };
  }
  const usersTable = {
    id: makeCol("id"),
    clerkId: makeCol("clerkId"),
    email: makeCol("email"),
    role: makeCol("role"),
    status: makeCol("status"),
  };
  const feedbackTicketsTable = {
    id: makeCol("id"),
    tenantId: makeCol("tenantId"),
    submitterId: makeCol("submitterId"),
    type: makeCol("type"),
    status: makeCol("status"),
    priority: makeCol("priority"),
    assigneeId: makeCol("assigneeId"),
    createdAt: makeCol("createdAt"),
    updatedAt: makeCol("updatedAt"),
  };
  const feedbackTicketCommentsTable = {
    id: makeCol("id"),
    ticketId: makeCol("ticketId"),
    createdAt: makeCol("createdAt"),
  };
  const notificationsTable = { id: makeCol("id") };
  const adminSettingsTable = { id: makeCol("id") };
  const auditLogsTable = { id: makeCol("id") };

  type Pred = Record<string, unknown> & { op?: string };
  function evalRow(row: Record<string, unknown>, pred?: Pred): boolean {
    if (!pred) return true;
    if (pred.op === "and")
      return (pred.conds as Pred[]).every((c) => evalRow(row, c));
    if (pred.op === "in") {
      const colName = (pred.col as { _name?: string })._name as string;
      return (pred.values as unknown[]).includes(row[colName]);
    }
    if (pred.op === "gte") {
      const colName = (pred.col as { _name?: string })._name as string;
      return (
        new Date(row[colName] as Date | string).getTime() >=
        new Date(pred.val as Date | string).getTime()
      );
    }
    if (pred.op === "lte" || pred.op === "lt") {
      const colName = (pred.col as { _name?: string })._name as string;
      const left = new Date(row[colName] as Date | string).getTime();
      const right = new Date(pred.val as Date | string).getTime();
      return pred.op === "lt" ? left < right : left <= right;
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
    if (t === adminSettingsTable) return "settings";
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
        from(t: unknown) {
          const k = tableForName(t);
          if (k) table = k;
          return builder;
        },
        where(p: Pred) {
          pred = p;
          return builder;
        },
        orderBy(..._args: unknown[]) {
          return builder;
        },
        limit(n: number) {
          _limit = n;
          return builder;
        },
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
              row = {
                id: state.nextTicketId++,
                ...(v as Record<string, unknown>),
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            } else if (key === "comments") {
              row = {
                id: state.nextCommentId++,
                ...(v as Record<string, unknown>),
                createdAt: new Date(),
              };
            } else if (key === "notifications") {
              row = {
                id: state.nextNotificationId++,
                isRead: false,
                ...(v as Record<string, unknown>),
                createdAt: new Date(),
              };
            } else if (key === "users") {
              row = {
                ...(v as Record<string, unknown>),
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            } else {
              row = {
                id: state.nextAuditId++,
                ...(v as Record<string, unknown>),
              };
            }
            if (key) (state[key] as Record<string, unknown>[]).push(row);
            inserted.push(row);
          }
          return {
            returning: () => Promise.resolve(inserted),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(inserted).then(resolve),
          };
        },
      };
    },
    update(t: unknown) {
      const key = tableForName(t);
      let pred: Pred | undefined;
      let setVals: Record<string, unknown> = {};
      const builder = {
        set(v: Record<string, unknown>) {
          setVals = v;
          return builder;
        },
        where(p: Pred) {
          pred = p;
          return builder;
        },
        returning: () => {
          const rows = (
            state[key as keyof typeof state] as Record<string, unknown>[]
          ).filter((r) => evalRow(r, pred));
          rows.forEach((r) => Object.assign(r, setVals));
          return Promise.resolve(rows);
        },
      };
      return builder;
    },
  };

  return {
    state,
    db,
    usersTable,
    feedbackTicketsTable,
    feedbackTicketCommentsTable,
    notificationsTable,
    adminSettingsTable,
    auditLogsTable,
  };
});

const dbState = hoistedDb.state;

vi.mock("@workspace/db", () => ({
  db: hoistedDb.db,
  usersTable: hoistedDb.usersTable,
  feedbackTicketsTable: hoistedDb.feedbackTicketsTable,
  feedbackTicketCommentsTable: hoistedDb.feedbackTicketCommentsTable,
  notificationsTable: hoistedDb.notificationsTable,
  adminSettingsTable: hoistedDb.adminSettingsTable,
  auditLogsTable: hoistedDb.auditLogsTable,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  desc: (col: unknown) => col,
  asc: (col: unknown) => col,
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  inArray: (col: unknown, values: unknown[]) => ({ op: "in", col, values }),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

import feedbackRouter from "../feedback";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    };
    next();
  });
  app.use("/api", feedbackRouter);
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: (err as Error).message });
    },
  );
  return app;
}

function seedUser(id: number, clerkId: string, role: string): UserRow {
  const u: UserRow = {
    id,
    clerkId,
    email: `${clerkId}@example.com`,
    firstName: "F",
    lastName: "L",
    role,
    status: "approved",
    isActive: true,
    contactPhone: null,
    mfaEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
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
  dbState.settings = [];
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
    seedUser(98, "global", "global_admin");
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
    expect(res.body.status).toBe("submitted");
    expect(res.body.priority).toBe(false);

    // Both admin + global admin get notified.
    const notifiedIds = dbState.notifications.map((n) => n.userId).sort();
    expect(notifiedIds).toEqual([98, 99]);
    expect(dbState.notifications.every((n) => n.type === "feedback_new")).toBe(
      true,
    );
  });

  it("normalizes absent screenshot/context values to null before insert", async () => {
    seedUser(1, "actor-clerk-id", "global_admin");
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).post("/api/feedback").send({
      type: "ux",
      severity: "medium",
      title: "Merchant Services Wrongfully named",
      description: "This is actually Customer Credit. Rename it.",
      pageUrl: "https://myorder.fun/admin/credits",
      userAgent: "Mozilla/5.0",
      context: null,
      screenshotData: false,
    });

    expect(res.status).toBe(201);
    expect(dbState.tickets[0]).toMatchObject({
      tenantId: 1,
      submitterId: 1,
      submitterRole: "global_admin",
      type: "ux",
      severity: "medium",
      status: "submitted",
      priority: false,
      title: "Merchant Services Wrongfully named",
      description: "This is actually Customer Credit. Rename it.",
      pageUrl: "https://myorder.fun/admin/credits",
      userAgent: "Mozilla/5.0",
      contextJson: null,
      screenshotData: null,
    });
  });

  it("stores object context and string screenshot data when provided", async () => {
    seedUser(1, "actor-clerk-id", "user");
    setMockUserId("actor-clerk-id");
    const screenshotData = "data:image/png;base64,abcd1234=";

    const res = await supertest(buildApp())
      .post("/api/feedback")
      .send({
        type: "bug",
        severity: "high",
        title: "Screenshot included",
        description: "The screenshot should be persisted.",
        context: { route: "/admin/credits" },
        screenshotData,
      });

    expect(res.status).toBe(201);
    expect(dbState.tickets[0]?.contextJson).toEqual({
      route: "/admin/credits",
    });
    expect(dbState.tickets[0]?.screenshotData).toBe(screenshotData);
  });

  it("returns a generic message when ticket insert fails", async () => {
    seedUser(1, "actor-clerk-id", "user");
    setMockUserId("actor-clerk-id");
    const insertSpy = vi
      .spyOn(hoistedDb.db, "insert")
      .mockImplementationOnce(() => {
        throw new Error(
          "Failed query: insert into feedback_tickets params: secret",
        );
      });

    const res = await supertest(buildApp()).post("/api/feedback").send({
      type: "general",
      severity: "low",
      title: "Generic failure",
      description: "Do not leak SQL details.",
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Feedback could not be submitted. Please try again.",
    });
    expect(JSON.stringify(res.body)).not.toContain("Failed query");
    insertSpy.mockRestore();
  });

  it("rejects payload that fails validation", async () => {
    seedUser(1, "actor-clerk-id", "user");
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp())
      .post("/api/feedback")
      .send({ type: "bogus", title: "x", description: "y" });
    expect(res.status).toBe(400);
  });
  it.each(["user", "customer_service_rep", "supervisor", "admin"])(
    "allows approved %s to submit feedback",
    async (role) => {
      seedUser(1, "actor-clerk-id", role);
      setMockUserId("actor-clerk-id");
      const res = await supertest(buildApp()).post("/api/feedback").send({
        type: "general",
        severity: "medium",
        title: "Helpful feedback",
        description: "This is useful feedback.",
      });
      expect(res.status).toBe(201);
      expect(res.body.submitterId).toBe(1);
    },
  );

  it.each([
    "tenantId",
    "userId",
    "role",
    "status",
    "reviewedBy",
    "archivedBy",
    "ticketId",
  ])("rejects client supplied protected field %s", async (field) => {
    seedUser(20 + String(field).length, `actor-${field}`, "user");
    setMockUserId(`actor-${field}`);
    const res = await supertest(buildApp())
      .post("/api/feedback")
      .send({
        type: "bug",
        severity: "low",
        title: "Protected field",
        description: "Must be rejected.",
        [field]: "attacker-controlled",
      });
    expect(res.status).toBe(400);
  });

  it("rate limits repeated submissions per authenticated user", async () => {
    seedUser(99, "rate-clerk-id", "user");
    setMockUserId("rate-clerk-id");
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      const res = await supertest(app)
        .post("/api/feedback")
        .send({
          type: "general",
          severity: "low",
          title: `Rate ${i}`,
          description: "Allowed submission.",
        });
      expect(res.status).toBe(201);
    }
    const limited = await supertest(app).post("/api/feedback").send({
      type: "general",
      severity: "low",
      title: "Rate limited",
      description: "Blocked submission.",
    });
    expect(limited.status).toBe(429);
  });
});

describe("GET /api/feedback (RBAC)", () => {
  it("regular user cannot list the admin feedback inbox", async () => {
    seedUser(1, "actor-clerk-id", "user");
    seedUser(2, "other-user", "user");
    seedUser(99, "admin1", "admin");
    // Pre-existing tickets from other people.
    dbState.tickets.push(
      {
        id: 10,
        tenantId: 1,
        submitterId: 2,
        type: "bug",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "not yours",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 11,
        tenantId: 1,
        submitterId: 1,
        type: "ux",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "yours",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
    dbState.nextTicketId = 12;
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/admin/feedback");
    expect(res.status).toBe(403);
  });

  it("admin sees every ticket", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    seedUser(2, "other-user", "user");
    dbState.tickets.push(
      {
        id: 10,
        tenantId: 1,
        submitterId: 2,
        type: "bug",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "a",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 11,
        tenantId: 1,
        submitterId: 1,
        type: "ux",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "b",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/admin/feedback");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { id: number }) => t.id).sort()).toEqual([
      10, 11,
    ]);
  });
});

describe("GET /api/feedback/:id (RBAC)", () => {
  it("blocks a regular user from reading someone else's ticket", async () => {
    seedUser(1, "actor-clerk-id", "user");
    seedUser(2, "other-user", "user");
    dbState.tickets.push({
      id: 7,
      tenantId: 1,
      submitterId: 2,
      type: "bug",
      severity: "low",
      status: "submitted",
      priority: false,
      title: "private",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp()).get("/api/admin/feedback/7");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/feedback/:id", () => {
  it("admin can change status, and submitter is notified", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    seedUser(2, "submitter", "user");
    dbState.tickets.push({
      id: 5,
      tenantId: 1,
      submitterId: 2,
      type: "bug",
      severity: "high",
      status: "submitted",
      priority: false,
      title: "broken",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");

    const res = await supertest(buildApp())
      .patch("/api/admin/feedback/5")
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
      id: 5,
      tenantId: 1,
      submitterId: 1,
      type: "bug",
      severity: "high",
      status: "submitted",
      priority: false,
      title: "broken",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp())
      .patch("/api/admin/feedback/5")
      .send({ status: "closed" });
    expect(res.status).toBe(403);
  });
});

describe("admin feedback tenant isolation and management actions", () => {
  it("tenant admin cannot read or update another tenant feedback item", async () => {
    const admin = seedUser(1, "actor-clerk-id", "tenant_admin") as UserRow & {
      tenantId: number;
    };
    admin.tenantId = 10;
    dbState.tickets.push({
      id: 9,
      tenantId: 20,
      submitterId: 2,
      type: "bug",
      severity: "high",
      status: "submitted",
      priority: false,
      title: "other tenant",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");

    expect(
      (await supertest(buildApp()).get("/api/admin/feedback/9")).status,
    ).toBe(404);
    expect(
      (
        await supertest(buildApp())
          .patch("/api/admin/feedback/9")
          .send({ status: "reviewed" })
      ).status,
    ).toBe(404);
  });

  it.each(["user", "customer_service_rep"])(
    "blocks %s from admin feedback inbox",
    async (role) => {
      seedUser(1, "actor-clerk-id", role);
      setMockUserId("actor-clerk-id");
      const res = await supertest(buildApp()).get("/api/admin/feedback");
      expect(res.status).toBe(403);
    },
  );

  it("admin can mark reviewed, unread, archive, restore, and create ticket", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    dbState.tickets.push({
      id: 5,
      tenantId: 1,
      submitterId: 2,
      type: "bug",
      severity: "high",
      status: "submitted",
      priority: false,
      title: "broken",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");
    const app = buildApp();

    expect(
      (await supertest(app).patch("/api/admin/feedback/5/reviewed")).body
        .status,
    ).toBe("reviewed");
    expect(
      (await supertest(app).patch("/api/admin/feedback/5/unread")).body.status,
    ).toBe("submitted");
    expect(
      (await supertest(app).patch("/api/admin/feedback/5/archive")).body.status,
    ).toBe("closed");
    expect(
      (await supertest(app).patch("/api/admin/feedback/5/restore")).body.status,
    ).toBe("submitted");
    const ticket = await supertest(app).post(
      "/api/admin/feedback/5/create-ticket",
    );
    expect(ticket.status).toBe(200);
    expect(ticket.body.ticket.priority).toBe(true);
    expect(dbState.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "feedback.reviewed",
        "feedback.submitted",
        "feedback.closed",
        "feedback.create_ticket",
      ]),
    );
  });

  it("auto-archives reviewed feedback while keeping unread feedback by default", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    dbState.settings.push({
      id: 1,
      tenantId: 1,
      feedbackArchiveReviewedAfterDays: 30,
      feedbackArchiveUnreadAfterDays: 30,
      feedbackArchiveUnreadEnabled: false,
    });
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    dbState.tickets.push(
      {
        id: 1,
        tenantId: 1,
        submitterId: 2,
        type: "bug",
        severity: "low",
        status: "reviewed",
        priority: false,
        title: "reviewed",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: old,
        updatedAt: old,
      },
      {
        id: 2,
        tenantId: 1,
        submitterId: 2,
        type: "bug",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "unread",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: old,
        updatedAt: old,
      },
    );
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp()).post(
      "/api/admin/feedback/archive-policy/run",
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ archivedReviewed: 1, archivedUnread: 0 });
    expect(dbState.tickets.find((t) => t.id === 1)?.status).toBe("closed");
    expect(dbState.tickets.find((t) => t.id === 2)?.status).toBe("submitted");
    expect(
      dbState.audits.some((a) => a.action === "feedback.auto_archive.reviewed"),
    ).toBe(true);
  });
});

describe("tenant-scoped user feedback history and notes", () => {
  it("regular user lists only their own submitted feedback", async () => {
    const actor = seedUser(1, "actor-clerk-id", "user") as UserRow & {
      tenantId: number;
    };
    actor.tenantId = 1;
    dbState.tickets.push(
      {
        id: 21,
        tenantId: 1,
        submitterId: 1,
        type: "general",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "mine",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 22,
        tenantId: 1,
        submitterId: 2,
        type: "general",
        severity: "low",
        status: "submitted",
        priority: false,
        title: "other",
        description: "x",
        pageUrl: null,
        userAgent: null,
        screenshotData: null,
        assigneeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp()).get("/api/feedback");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { id: number }) => t.id)).toEqual([21]);
  });

  it("hides internal notes but shows public notes to submitter", async () => {
    seedUser(1, "actor-clerk-id", "user");
    dbState.tickets.push({
      id: 31,
      tenantId: 1,
      submitterId: 1,
      type: "bug",
      severity: "low",
      status: "reviewed",
      priority: false,
      title: "mine",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dbState.comments.push(
      {
        id: 1,
        ticketId: 31,
        authorId: 99,
        body: "public reply",
        isInternal: false,
        createdAt: new Date(),
      },
      {
        id: 2,
        ticketId: 31,
        authorId: 99,
        body: "internal only",
        isInternal: true,
        createdAt: new Date(),
      },
    );
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp()).get("/api/feedback/31/comments");
    expect(res.status).toBe(200);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual([
      "public reply",
    ]);
  });

  it("rejects unknown fields on admin update", async () => {
    seedUser(1, "actor-clerk-id", "admin");
    dbState.tickets.push({
      id: 41,
      tenantId: 1,
      submitterId: 2,
      type: "bug",
      severity: "low",
      status: "submitted",
      priority: false,
      title: "mine",
      description: "x",
      pageUrl: null,
      userAgent: null,
      screenshotData: null,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setMockUserId("actor-clerk-id");
    const res = await supertest(buildApp())
      .patch("/api/admin/feedback/41")
      .send({ status: "reviewed", tenantId: 999 });
    expect(res.status).toBe(400);
  });
});
