/**
 * Waitlist invite-with-role tests.
 *
 * Verifies POST /api/admin/users/waitlist/:id/invite:
 *  - calls clerkClient.waitlistEntries.invite with the right entry id
 *  - inserts a `users` row with status='approved', the picked role, the
 *    email pulled from the Clerk waitlist entry, and a sentinel clerkId
 *    of the form `pending_invite:<entryId>`
 *  - writes an INVITE_WAITLIST_USER audit log
 *  - is idempotent on re-invite (onConflictDoUpdate by clerkId)
 *  - rejects an invalid role with a 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "admin-clerk-id";

vi.mock("@clerk/express", () => {
  const updateUserMetadata = vi.fn(async () => ({}));
  const getUser = vi.fn(async () => ({ publicMetadata: {} }));
  const invite = vi.fn(async (id: string) => ({
    id,
    status: "invited",
    emailAddress: "newhire@example.com",
  }));
  const list = vi.fn(async () => ({ data: [], totalCount: 0 }));
  const reject = vi.fn(async (id: string) => ({ id, status: "rejected" }));
  return {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId, sessionClaims: undefined } : {})),
    clerkClient: {
      users: { updateUserMetadata, getUser },
      waitlistEntries: { invite, list, reject },
    },
  };
});

type Row = Record<string, unknown>;
const dbState = {
  users: [] as Row[],
  audits: [] as Row[],
  notifications: [] as Row[],
};

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "id",
    clerkId: "clerkId",
    email: "email",
    status: "status",
    role: "role",
    createdAt: "createdAt",
  };
  const notificationsTable = { __t: "notifications" };
  const auditLogsTable = { __t: "audits" };

  type Pred = ((row: Row) => boolean) | null;

  // Build a row predicate from a drizzle expression. `eq`/`ne` produce
  // `{op,col,val}` and `and(...)` produces an array; recurse on arrays.
  type Expr =
    | { op?: string; col?: string; val?: unknown }
    | Expr[]
    | null
    | undefined;
  function predOf(expr: Expr): (row: Row) => boolean {
    if (!expr) return () => true;
    if (Array.isArray(expr)) {
      const parts = expr.map(predOf);
      return (row) => parts.every((p) => p(row));
    }
    const { op = "eq", col, val } = expr;
    // If a predicate references a column the mock table does not define,
    // we must NOT match every row — that silently broadens queries and hides
    // bugs (e.g. eq(undefinedCol, x) matching admin and demoting them).
    if (!col) return () => false;
    if (op === "ne") return (row) => row[col] !== val;
    return (row) => row[col] === val;
  }

  const select = vi.fn(() => {
    let pred: Pred = null;
    let table: keyof typeof dbState = "users";
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: { __t?: string }) => {
      table = (t?.__t as keyof typeof dbState) ?? "users";
      return chain;
    });
    chain.where = vi.fn((p: Expr) => { pred = predOf(p); return chain; });
    chain.orderBy = vi.fn(() => Promise.resolve(dbState[table].filter((r) => (pred ? pred(r) : true))));
    chain.limit = vi.fn(() => Promise.resolve(dbState[table].filter((r) => (pred ? pred(r) : true))));
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
      resolve(dbState[table].filter((r) => (pred ? pred(r) : true)));
    return chain;
  });

  const update = vi.fn(() => {
    let setVals: Row = {};
    let pred: Pred = null;
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((v: Row) => { setVals = v; return chain; });
    chain.where = vi.fn((p: Expr) => { pred = predOf(p); return chain; });
    // The invite handler awaits `update().set().where()` without calling
    // `.returning()`, so the where step itself must apply the mutation when
    // awaited. We also expose `.returning()` for callers that need the row.
    const apply = () => {
      const out: Row[] = [];
      for (const row of dbState.users) {
        if (pred && pred(row)) {
          Object.assign(row, setVals);
          out.push(row);
        }
      }
      return out;
    };
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) => resolve(apply());
    chain.returning = vi.fn(async () => apply());
    return chain;
  });

  const insert = vi.fn((table: { __t?: string }) => {
    const tname = (table?.__t as keyof typeof dbState) ?? "users";
    const chain: Record<string, unknown> = {};
    let pendingValues: Row | null = null;
    chain.values = vi.fn((v: Row) => {
      pendingValues = v;
      // Auto-resolve the chain for plain `await db.insert(...).values(...)`.
      const valuesChain: Record<string, unknown> = {};
      valuesChain.onConflictDoUpdate = vi.fn(async ({ set }: { target: unknown; set: Row }) => {
        // Conflict on clerkId: replace if exists, else push.
        const idx = dbState[tname].findIndex(
          (r) => r.clerkId === (pendingValues as Row).clerkId,
        );
        if (idx >= 0) {
          Object.assign(dbState[tname][idx], pendingValues, set);
        } else {
          dbState[tname].push({ ...pendingValues });
        }
      });
      (valuesChain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) => {
        dbState[tname].push({ ...pendingValues });
        return resolve(undefined);
      };
      return valuesChain;
    });
    return chain;
  });

  return {
    db: { select, update, insert, delete: vi.fn() },
    usersTable,
    notificationsTable,
    auditLogsTable,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ op: "eq", col, val })),
  ne: vi.fn((col, val) => ({ op: "ne", col, val })),
  and: vi.fn((...args) => args),
  desc: vi.fn((col) => col),
  asc: vi.fn((col) => col),
  like: vi.fn((col, val) => ({ op: "like", col, val })),
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", usersRouter);
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

beforeEach(() => {
  vi.clearAllMocks();
  dbState.users = [];
  dbState.audits = [];
  dbState.notifications = [];
  mockUserId = "admin-clerk-id";
});

describe("POST /api/admin/users/waitlist/:id/invite", () => {
  it("invites the waitlist entry and pre-creates an approved users row with the picked role", async () => {
    seedAdmin();
    const app = buildApp();
    const res = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_abc/invite")
      .send({ role: "customer_service_rep", firstName: "Sam", lastName: "Hire" });

    expect(res.status).toBe(200);
    expect(res.body.userRowCreated).toBe(true);
    expect(res.body.role).toBe("customer_service_rep");
    expect(res.body.email).toBe("newhire@example.com");

    expect(clerkClient.waitlistEntries.invite).toHaveBeenCalledWith(
      "wlent_abc",
      { ignoreExisting: true },
    );

    const created = dbState.users.find(
      (u) => u.clerkId === "pending_invite:wlent_abc",
    );
    expect(created).toBeTruthy();
    expect(created?.status).toBe("approved");
    expect(created?.role).toBe("customer_service_rep");
    expect(created?.email).toBe("newhire@example.com");
    expect(created?.firstName).toBe("Sam");
    expect(created?.lastName).toBe("Hire");
  });

  it("defaults to role 'user' when no role is supplied", async () => {
    seedAdmin();
    const app = buildApp();
    const res = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_default/invite")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("user");
    const created = dbState.users.find(
      (u) => u.clerkId === "pending_invite:wlent_default",
    );
    expect(created?.role).toBe("user");
    expect(created?.status).toBe("approved");
  });

  it("rejects an unknown role with 400", async () => {
    seedAdmin();
    const app = buildApp();
    const res = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_bad/invite")
      .send({ role: "godmode" });
    expect(res.status).toBe(400);
    expect(clerkClient.waitlistEntries.invite).not.toHaveBeenCalled();
  });

  it("promotes an existing real user instead of creating a sentinel when the email already has an account", async () => {
    seedAdmin();
    // Pre-existing real user with a real Clerk id and the same email the
    // waitlist invite would resolve to.
    dbState.users.push({
      id: 42,
      clerkId: "user_real_clerk_id",
      email: "newhire@example.com",
      firstName: "Existing",
      lastName: "Person",
      role: "user",
      status: "pending",
      isActive: true,
      contactPhone: null,
      avatarUrl: null,
      mfaEnabled: false,
      tenantId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp();
    const res = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_existing/invite")
      .send({ role: "supervisor" });

    expect(res.status).toBe(200);
    expect(res.body.promotedExisting).toBe(true);
    expect(res.body.userRowCreated).toBe(false);

    // No sentinel row should be created.
    const sentinel = dbState.users.find(
      (u) => u.clerkId === "pending_invite:wlent_existing",
    );
    expect(sentinel).toBeUndefined();

    // Existing row promoted to approved + new role.
    const promoted = dbState.users.find((u) => u.id === 42)!;
    expect(promoted.status).toBe("approved");
    expect(promoted.role).toBe("supervisor");

    // And we mirror status+role into Clerk via the real id.
    expect(clerkClient.users.updateUserMetadata).toHaveBeenCalledWith(
      "user_real_clerk_id",
      { publicMetadata: expect.objectContaining({ status: "approved", role: "supervisor" }) },
    );
  });

  it("is idempotent on re-invite (upserts by clerkId sentinel)", async () => {
    seedAdmin();
    const app = buildApp();
    const first = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_repeat/invite")
      .send({ role: "user" });
    expect(first.status).toBe(200);

    const second = await supertest(app)
      .post("/api/admin/users/waitlist/wlent_repeat/invite")
      .send({ role: "supervisor", firstName: "Updated" });
    expect(second.status).toBe(200);

    const matches = dbState.users.filter(
      (u) => u.clerkId === "pending_invite:wlent_repeat",
    );
    expect(matches.length).toBe(1);
    expect(matches[0].role).toBe("supervisor");
    expect(matches[0].firstName).toBe("Updated");
  });
});
