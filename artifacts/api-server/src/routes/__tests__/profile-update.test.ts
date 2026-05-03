/**
 * PATCH /api/users/me — current-user profile editing tests.
 *
 *  - successful update writes name, phone, avatar to the DB row
 *  - real Clerk user IDs get a name mirror via clerkClient.users.updateUser
 *  - sentinel `pending_invite:*` clerkIds skip the Clerk mirror call
 *  - invalid phone or avatar URL returns 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "self-clerk-id";

vi.mock("@clerk/express", () => {
  const updateUser = vi.fn(async () => ({}));
  const updateUserMetadata = vi.fn(async () => ({}));
  const getUser = vi.fn(async () => ({ publicMetadata: {} }));
  return {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId, sessionClaims: undefined } : {})),
    clerkClient: {
      users: { updateUser, updateUserMetadata, getUser },
      waitlistEntries: { invite: vi.fn(), list: vi.fn(), reject: vi.fn() },
    },
  };
});

type Row = Record<string, unknown>;
const dbState = { users: [] as Row[], audits: [] as Row[], notifications: [] as Row[] };

vi.mock("@workspace/db", () => {
  const usersTable = { id: "id", clerkId: "clerkId" };
  const auditLogsTable = { __t: "audits" };
  const notificationsTable = { __t: "notifications" };

  type Pred = ((row: Row) => boolean) | null;

  const select = vi.fn(() => {
    let pred: Pred = null;
    let table: keyof typeof dbState = "users";
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: { __t?: string }) => {
      table = (t?.__t as keyof typeof dbState) ?? "users";
      return chain;
    });
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
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
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
    chain.returning = vi.fn(async () => {
      const out: Row[] = [];
      for (const row of dbState.users) {
        if (pred && pred(row)) {
          Object.assign(row, setVals);
          out.push(row);
        }
      }
      return out;
    });
    return chain;
  });

  const insert = vi.fn((table: { __t?: string }) => {
    const tname = (table?.__t as keyof typeof dbState) ?? "users";
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(async (v: Row) => { dbState[tname].push({ ...v }); });
    return chain;
  });

  return {
    db: { select, update, insert, delete: vi.fn() },
    usersTable,
    auditLogsTable,
    notificationsTable,
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

function seedSelf(clerkId = "self-clerk-id") {
  dbState.users.push({
    id: 7,
    clerkId,
    email: "self@example.com",
    firstName: "Old",
    lastName: "Name",
    role: "user",
    status: "approved",
    isActive: true,
    contactPhone: null,
    avatarUrl: null,
    mfaEnabled: false,
    tenantId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.users = [];
  dbState.audits = [];
  dbState.notifications = [];
  mockUserId = "self-clerk-id";
});

describe("PATCH /api/users/me", () => {
  it("updates firstName, lastName, phone, avatar in the DB and mirrors name to Clerk", async () => {
    seedSelf();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({
        firstName: "New",
        lastName: "Person",
        contactPhone: "+15558675309",
        avatarUrl: "https://cdn.example.com/avatar.png",
      });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe("New");
    expect(res.body.lastName).toBe("Person");
    expect(res.body.contactPhone).toBe("+15558675309");
    expect(res.body.avatarUrl).toBe("https://cdn.example.com/avatar.png");

    const row = dbState.users.find((u) => u.id === 7)!;
    expect(row.firstName).toBe("New");
    expect(row.avatarUrl).toBe("https://cdn.example.com/avatar.png");

    expect(clerkClient.users.updateUser).toHaveBeenCalledWith(
      "self-clerk-id",
      expect.objectContaining({ firstName: "New", lastName: "Person" }),
    );
  });

  it("skips Clerk mirror for sentinel pending_invite clerkIds", async () => {
    mockUserId = "pending_invite:wlent_xyz";
    seedSelf("pending_invite:wlent_xyz");
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ firstName: "Solo" });
    expect(res.status).toBe(200);
    expect(clerkClient.users.updateUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid avatar URL with 400", async () => {
    seedSelf();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "not a url at all" });
    expect(res.status).toBe(400);
    expect(clerkClient.users.updateUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number with 400", async () => {
    seedSelf();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ contactPhone: "abcdef" });
    expect(res.status).toBe(400);
  });

  it("clears phone and avatar when null is supplied", async () => {
    seedSelf();
    dbState.users[0].contactPhone = "+15551112222";
    dbState.users[0].avatarUrl = "https://x.example/a.png";
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ contactPhone: null, avatarUrl: null });
    expect(res.status).toBe(200);
    expect(res.body.contactPhone).toBeUndefined();
    expect(res.body.avatarUrl).toBeUndefined();
    const row = dbState.users.find((u) => u.id === 7)!;
    expect(row.contactPhone).toBeNull();
    expect(row.avatarUrl).toBeNull();
  });
});
