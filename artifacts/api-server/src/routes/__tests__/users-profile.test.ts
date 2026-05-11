/**
 * Profile editing tests for /api/users/me.
 *
 * Verifies:
 *  - GET /api/users/me returns the current user record (with avatarUrl).
 *  - PATCH /api/users/me updates allowed fields (firstName/lastName/contactPhone/avatarUrl).
 *  - PATCH mirrors name + phone to Clerk via clerkClient.users.updateUser.
 *  - PATCH mirrors avatar to Clerk via clerkClient.users.updateUserProfileImage.
 *  - PATCH rejects invalid phone with HTTP 400 (JSON error body).
 *  - PATCH ignores unknown fields (does not 400, does not persist them).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "user-clerk-id";

vi.mock("@clerk/express", () => {
  const updateUser = vi.fn(async () => ({}));
  const updateUserMetadata = vi.fn(async () => ({}));
  const updateUserProfileImage = vi.fn(async () => ({}));
  const getUser = vi.fn(async () => ({ publicMetadata: {} }));
  return {
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId } : {})),
    clerkClient: { users: { updateUser, updateUserMetadata, updateUserProfileImage, getUser } },
  };
});

const dbState = {
  users: [] as Array<Record<string, unknown>>,
};

vi.mock("@workspace/db", () => {
  const usersTable = { id: "id", clerkId: "clerkId" };
  const notificationsTable = {};
  const auditLogsTable = {};

  type Pred = ((row: Record<string, unknown>) => boolean) | null;

  const select = vi.fn(() => {
    let pred: Pred = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
    chain.orderBy = vi.fn(() => Promise.resolve(dbState.users.filter((r) => (pred ? pred(r) : true))));
    chain.limit = vi.fn(() => Promise.resolve(dbState.users.filter((r) => (pred ? pred(r) : true))));
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
      resolve(dbState.users.filter((r) => (pred ? pred(r) : true)));
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
    return chain;
  });

  const insert = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(async () => {});
    chain.returning = vi.fn(async () => []);
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

// Avatar SSRF guard resolves DNS via node:dns/promises. Mock it so the
// test suite doesn't hit the network and so we can drive the guard with
// chosen IPs.
const dnsLookup = vi.fn(async (host: string) => {
  if (host === "private.example.com") return [{ address: "10.0.0.5", family: 4 }];
  if (host === "metadata.example.com") return [{ address: "169.254.169.254", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }]; // public
});
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...a: unknown[]) => dnsLookup(...(a as [string])) },
  lookup: (...a: unknown[]) => dnsLookup(...(a as [string])),
}));

import { clerkClient } from "@clerk/express";
import usersRouter from "../users";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", usersRouter);
  return app;
}

function seedUser(overrides: Record<string, unknown> = {}) {
  dbState.users.push({
    id: 1,
    clerkId: "user-clerk-id",
    email: "user@example.com",
    firstName: "Old",
    lastName: "Name",
    role: "user",
    status: "approved",
    isActive: true,
    contactPhone: null,
    avatarUrl: null,
    mfaEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.users = [];
  mockUserId = "user-clerk-id";
  // Default fetch mock for avatar sync — returns a tiny PNG.
  const png = new Uint8Array([137, 80, 78, 71]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === "content-type") return "image/png";
          if (name.toLowerCase() === "content-length") return String(png.byteLength);
          return null;
        },
      },
      arrayBuffer: async () => png.buffer,
    })),
  );
});

describe("GET /api/users/me", () => {
  it("returns the current user including avatarUrl", async () => {
    seedUser({ avatarUrl: "https://cdn.example.com/me.png", contactPhone: "+15551112222" });
    const res = await supertest(buildApp()).get("/api/users/me");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("user@example.com");
    expect(res.body.firstName).toBe("Old");
    expect(res.body.avatarUrl).toBe("https://cdn.example.com/me.png");
    expect(res.body.contactPhone).toBe("+15551112222");
  });
});

describe("PATCH /api/users/me", () => {
  it("updates name + phone and mirrors them to Clerk via updateUser", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({
        firstName: "Newfirst",
        lastName: "Newlast",
        contactPhone: "+1 555 333 4444",
      });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe("Newfirst");
    expect(res.body.lastName).toBe("Newlast");
    expect(res.body.contactPhone).toBe("+1 555 333 4444");

    const dbRow = dbState.users[0];
    expect(dbRow.firstName).toBe("Newfirst");
    expect(dbRow.lastName).toBe("Newlast");
    expect(dbRow.contactPhone).toBe("+1 555 333 4444");

    expect(clerkClient.users.updateUser).toHaveBeenCalledWith(
      "user-clerk-id",
      expect.objectContaining({
        firstName: "Newfirst",
        lastName: "Newlast",
        phoneNumber: ["+1 555 333 4444"],
      }),
    );
  });

  it("mirrors avatar changes to Clerk via updateUserProfileImage", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "https://cdn.example.com/new.png" });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("https://cdn.example.com/new.png");
    expect(dbState.users[0].avatarUrl).toBe("https://cdn.example.com/new.png");

    const fetchUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(String(fetchUrl)).toBe("https://cdn.example.com/new.png");
    expect(clerkClient.users.updateUserProfileImage).toHaveBeenCalledWith(
      "user-clerk-id",
      expect.objectContaining({ file: expect.anything() }),
    );
  });

  it("does not call updateUserProfileImage when avatar is not in the body", async () => {
    seedUser();
    await supertest(buildApp())
      .patch("/api/users/me")
      .send({ firstName: "JustName" });
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });

  it("rejects invalid phone numbers with HTTP 400 (JSON error)", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ contactPhone: "abc" });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(typeof res.body.error).toBe("string");
    expect(clerkClient.users.updateUser).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
    // DB row not mutated
    expect(dbState.users[0].firstName).toBe("Old");
  });

  it("ignores unknown fields (does not 400, does not persist them)", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({
        firstName: "Updated",
        role: "admin",
        status: "rejected",
        isActive: false,
        clerkId: "hacker-clerk-id",
      });
    expect(res.status).toBe(200);
    // Allowed field saved
    expect(dbState.users[0].firstName).toBe("Updated");
    // Unknown / forbidden fields untouched in the DB
    expect(dbState.users[0].role).toBe("user");
    expect(dbState.users[0].status).toBe("approved");
    expect(dbState.users[0].isActive).toBe(true);
    expect(dbState.users[0].clerkId).toBe("user-clerk-id");
  });

  it("does not clobber fields that are not in the body", async () => {
    seedUser({ contactPhone: "+15550000000", avatarUrl: "https://cdn.example.com/old.png" });
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ firstName: "OnlyFirst" });
    expect(res.status).toBe(200);
    expect(dbState.users[0].firstName).toBe("OnlyFirst");
    expect(dbState.users[0].contactPhone).toBe("+15550000000");
    expect(dbState.users[0].avatarUrl).toBe("https://cdn.example.com/old.png");
  });

  it("clears a field when explicitly set to null", async () => {
    seedUser({ contactPhone: "+15550000000" });
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ contactPhone: null });
    expect(res.status).toBe(200);
    expect(dbState.users[0].contactPhone).toBeNull();
    // Phone still mirrored (with empty array meaning "clear")
    expect(clerkClient.users.updateUser).toHaveBeenCalledWith(
      "user-clerk-id",
      expect.objectContaining({ phoneNumber: [] }),
    );
  });

  it("SSRF guard: blocks avatar URLs that resolve to private IPs", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "https://private.example.com/me.png" });
    // DB write still succeeds (URL was validated as syntactically correct).
    expect(res.status).toBe(200);
    expect(dbState.users[0].avatarUrl).toBe("https://private.example.com/me.png");
    // But Clerk profile image is NOT updated and the URL is NOT fetched.
    expect(fetch).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });

  it("SSRF guard: blocks the cloud metadata endpoint (169.254.169.254)", async () => {
    seedUser();
    await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "http://metadata.example.com/latest/meta-data/" });
    expect(fetch).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });

  it("SSRF guard: blocks IP-literal localhost URLs", async () => {
    seedUser();
    await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "http://127.0.0.1/avatar.png" });
    expect(fetch).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });

  it("SSRF guard: blocks non-default ports", async () => {
    seedUser();
    await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "https://cdn.example.com:9999/me.png" });
    expect(fetch).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });

  it("accepts empty payloads as a no-op", async () => {
    seedUser();
    const res = await supertest(buildApp()).patch("/api/users/me").send({});
    expect(res.status).toBe(200);
    expect(clerkClient.users.updateUser).not.toHaveBeenCalled();
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
  });
});
