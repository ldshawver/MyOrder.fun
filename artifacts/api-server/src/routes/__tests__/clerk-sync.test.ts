/**
 * Clerk ↔ app approval sync tests.
 *
 * Verifies:
 *  - PATCH /api/admin/users/:id/approval updates the DB AND pushes to Clerk.
 *  - PATCH /api/users/:id/status updates the DB AND pushes to Clerk.
 *  - PATCH /api/users/:id/role updates the DB AND pushes to Clerk.
 *  - GET /api/admin/users/pending returns only pending DB rows.
 *  - loadDbUser reconciles the DB to Clerk publicMetadata on read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "admin-clerk-id";
let mockSessionClaims: Record<string, unknown> | undefined = undefined;

vi.mock("@clerk/express", () => {
  const updateUserMetadata = vi.fn(async () => ({}));
  const getUser = vi.fn(async () => ({ publicMetadata: {} }));
  return {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId, sessionClaims: mockSessionClaims } : {})),
    clerkClient: { users: { updateUserMetadata, getUser } },
  };
});

const dbState = {
  users: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
};

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "id",
    clerkId: "clerkId",
    status: "status",
    createdAt: "createdAt",
  };
  const notificationsTable = {};
  const auditLogsTable = {};

  type Pred = ((row: Record<string, unknown>) => boolean) | null;
  let lastPred: Pred = null;

  const select = vi.fn(() => {
    let pred: Pred = null;
    let table: keyof typeof dbState = "users";
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: unknown) => {
      if (t === notificationsTable) table = "notifications";
      else if (t === auditLogsTable) table = "audits";
      else table = "users";
      return chain;
    });
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
    chain.orderBy = vi.fn(() => Promise.resolve(dbState[table].filter((r) => (pred ? pred(r) : true))));
    chain.limit = vi.fn(() => Promise.resolve(dbState[table].filter((r) => (pred ? pred(r) : true))));
    // bare await chain.from(...).where(...) returns rows
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
      resolve(dbState[table].filter((r) => (pred ? pred(r) : true)));
    return chain;
  });

  const update = vi.fn(() => {
    let setVals: Record<string, unknown> = {};
    let pred: Pred = null;
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((v: Record<string, unknown>) => { setVals = v; return chain; });
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
    chain.returning = vi.fn(async () => {
      const out: Array<Record<string, unknown>> = [];
      for (const row of dbState.users) {
        if (pred && pred(row)) {
          Object.assign(row, setVals);
          out.push(row);
        }
      }
      return out;
    });
    lastPred = pred;
    return chain;
  });

  const insert = vi.fn(() => {
    const table: keyof typeof dbState = "notifications";
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(async (v: Record<string, unknown>) => {
      dbState[table].push(v);
    });
    return chain;
  });

  const delete_ = vi.fn();

  void lastPred;

  return {
    db: { select, update, insert, delete: delete_ },
    usersTable,
    notificationsTable,
    auditLogsTable,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  desc: vi.fn((col) => col),
  asc: vi.fn((col) => col),
}));

vi.mock("../../lib/sms", () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
  smsAccountApproved: vi.fn(() => "Welcome!"),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { clerkClient } from "@clerk/express";
import usersRouter from "../users";
import { loadDbUser, requireAuth } from "../../lib/auth";

function buildApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", router);
  return app;
}

function seedAdmin() {
  dbState.users.push({
    id: 1,
    clerkId: "admin-clerk-id",
    email: "admin@example.com",
    firstName: "Admin",
    lastName: "User",
    role: "admin",
    status: "approved",
    isActive: true,
    contactPhone: null,
    mfaEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function seedPending(id: number, clerkId: string) {
  dbState.users.push({
    id,
    clerkId,
    email: `pending${id}@example.com`,
    firstName: "Pending",
    lastName: "User",
    role: "user",
    status: "pending",
    isActive: true,
    contactPhone: "+15551112222",
    mfaEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.users = [];
  dbState.notifications = [];
  dbState.audits = [];
  mockUserId = "admin-clerk-id";
  mockSessionClaims = undefined;
});

describe("PATCH /api/admin/users/:id/approval", () => {
  it("approves a pending user, updates the DB, and pushes to Clerk", async () => {
    seedAdmin();
    seedPending(2, "pending-clerk-id");
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/2/approval")
      .send({ approve: true, role: "lab_tech" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.role).toBe("lab_tech");

    const dbRow = dbState.users.find((u) => u.id === 2)!;
    expect(dbRow.status).toBe("approved");
    expect(dbRow.role).toBe("lab_tech");

    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "pending-clerk-id",
      { publicMetadata: expect.objectContaining({ status: "approved", role: "lab_tech" }) },
    );
  });

  it("rejects a pending user, updates the DB, and pushes to Clerk", async () => {
    seedAdmin();
    seedPending(3, "pending-clerk-id-2");
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/3/approval")
      .send({ approve: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");

    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "pending-clerk-id-2",
      { publicMetadata: expect.objectContaining({ status: "rejected" }) },
    );
  });

  it("returns 404 for an unknown user id", async () => {
    seedAdmin();
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/999/approval")
      .send({ approve: true });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/users/pending", () => {
  it("returns only users with status='pending'", async () => {
    seedAdmin();
    seedPending(2, "p2");
    seedPending(3, "p3");
    dbState.users.push({
      id: 4, clerkId: "c4", email: "ok@x.com", firstName: null, lastName: null,
      role: "user", status: "approved", isActive: true, contactPhone: null,
      mfaEnabled: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const app = buildApp(usersRouter);
    const res = await supertest(app).get("/api/admin/users/pending");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.users.map((u: { id: number }) => u.id).sort()).toEqual([2, 3]);
  });
});

describe("Admin route aliases", () => {
  it("PATCH /api/admin/users/:id/status updates DB and Clerk", async () => {
    seedAdmin();
    seedPending(20, "alias-status-clerk-id");
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/20/status")
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "alias-status-clerk-id",
      { publicMetadata: expect.objectContaining({ status: "approved" }) },
    );
  });

  it("PATCH /api/admin/users/:id/role rejects supervisors with 403", async () => {
    dbState.users.push({
      id: 100, clerkId: "supervisor-clerk-id",
      email: "sup@example.com", firstName: "Sup", lastName: "User",
      role: "supervisor", status: "approved", isActive: true, contactPhone: null,
      mfaEnabled: false, createdAt: new Date(), updatedAt: new Date(),
    });
    seedPending(22, "alias-role-supervisor-clerk-id");
    mockUserId = "supervisor-clerk-id";
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/22/role")
      .send({ role: "user" });
    expect(res.status).toBe(403);
    expect(clerkClient.users.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("PATCH /api/admin/users/:id/role updates DB and Clerk", async () => {
    seedAdmin();
    seedPending(21, "alias-role-clerk-id");
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/admin/users/21/role")
      .send({ role: "supervisor" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("supervisor");
    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "alias-role-clerk-id",
      { publicMetadata: expect.objectContaining({ role: "supervisor" }) },
    );
  });
});

describe("PATCH /api/users/:id/status", () => {
  it("deactivating a user pushes 'deactivated' to Clerk publicMetadata", async () => {
    seedAdmin();
    seedPending(5, "deact-clerk-id");
    // Move to approved first to test deactivation
    dbState.users.find((u) => u.id === 5)!.status = "approved";
    const app = buildApp(usersRouter);
    const res = await supertest(app)
      .patch("/api/users/5/status")
      .send({ status: "deactivated" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deactivated");
    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "deact-clerk-id",
      { publicMetadata: expect.objectContaining({ status: "deactivated" }) },
    );
  });
});

describe("loadDbUser sync-on-read (Clerk wins)", () => {
  it("updates the DB row when Clerk publicMetadata.status differs", async () => {
    seedPending(7, "round-trip-clerk-id");
    mockUserId = "round-trip-clerk-id";
    // Clerk says approved, DB still says pending — sync-on-read should reconcile
    mockSessionClaims = { publicMetadata: { status: "approved", role: "lab_tech" } };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      next();
    });
    app.get("/whoami", requireAuth, loadDbUser, (req, res) => {
      res.json({ status: req.dbUser?.status, role: req.dbUser?.role });
    });

    const res = await supertest(app).get("/whoami");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.role).toBe("lab_tech");

    // DB row was reconciled
    const dbRow = dbState.users.find((u) => u.id === 7)!;
    expect(dbRow.status).toBe("approved");
    expect(dbRow.role).toBe("lab_tech");
  });

  it("does nothing when Clerk metadata matches the DB", async () => {
    seedPending(8, "matching-clerk-id");
    dbState.users.find((u) => u.id === 8)!.status = "approved";
    dbState.users.find((u) => u.id === 8)!.role = "user";
    mockUserId = "matching-clerk-id";
    mockSessionClaims = { publicMetadata: { status: "approved", role: "user" } };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      next();
    });
    app.get("/whoami", requireAuth, loadDbUser, (req, res) => {
      res.json({ status: req.dbUser?.status, role: req.dbUser?.role });
    });

    const res = await supertest(app).get("/whoami");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });
});
