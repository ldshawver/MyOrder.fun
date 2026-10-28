/**
 * Profile editing tests for /api/users/me.
 *
 * Verifies:
 *  - GET /api/users/me returns the current user record (with avatarUrl).
 *  - PATCH /api/users/me updates permitted fields and email-bound image uploads.
 *  - PATCH mirrors name + phone to Clerk via clerkClient.users.updateUser.
 *  - PATCH rejects direct URLs and image data supplied by the browser.
 *  - PATCH rejects invalid phone with HTTP 400 (JSON error body).
 *  - PATCH rejects protected and unknown fields.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "user-clerk-id";
const priorOwnerId = process.env.MYORDER_OWNER_CLERK_ID;

vi.mock("../../lib/profileImageStore", () => ({
  assertTemporaryProfileImage: vi.fn(async () => undefined),
  finalizeProfileImage: vi.fn(async () => undefined),
}));

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
  audits: [] as Array<Record<string, unknown>>,
};

vi.mock("@workspace/db", () => {
  const usersTable = { id: "id", clerkId: "clerkId", role: "role", tenantId: "tenantId", email: "email", status: "status", avatarUrl: "avatarUrl" };
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

  const insert = vi.fn((table?: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(async (row?: Record<string, unknown>) => { if (table === auditLogsTable && row) dbState.audits.push(row); });
    chain.returning = vi.fn(async () => []);
    return chain;
  });

  return {
    db: { execute: vi.fn(() => Promise.resolve()), select, update, insert, transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({ update, insert })), delete: vi.fn() },
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
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
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
import { assertTemporaryProfileImage, finalizeProfileImage } from "../../lib/profileImageStore";
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
    approvedByClerkId: "owner-clerk-id",
    approvedAt: new Date("2026-01-01T00:00:00Z"),
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
  process.env.MYORDER_OWNER_CLERK_ID = "owner-clerk-id";
  vi.clearAllMocks();
  dbState.users = [];
  dbState.audits = [];
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

afterAll(() => {
  if (priorOwnerId === undefined) delete process.env.MYORDER_OWNER_CLERK_ID;
  else process.env.MYORDER_OWNER_CLERK_ID = priorOwnerId;
});

describe("GET /api/users/me", () => {
  it("returns the current user including avatarUrl", async () => {
    seedUser({ avatarUrl: "https://cdn.example.com/me.png", contactPhone: "+15551112222" });
    const res = await supertest(buildApp()).get("/api/users/me");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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

  it("attaches a validated server upload without accepting image bytes or URLs", async () => {
    seedUser();
    const imageId = "f2862f21-4f21-48f2-8cad-79bde3f2c2c3";
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ profileImageUploadId: imageId });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe(`/api/profile-images/${imageId}`);
    expect(assertTemporaryProfileImage).toHaveBeenCalledWith(imageId, "user@example.com");
    expect(finalizeProfileImage).toHaveBeenCalledWith(imageId);
    expect(clerkClient.users.updateUserProfileImage).not.toHaveBeenCalled();
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

  it("rejects attempts to modify role, approval, active state, and identity", async () => {
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
    expect(res.status).toBe(400);
    expect(dbState.users[0].firstName).toBe("Old");
    // Unknown / forbidden fields untouched in the DB
    expect(dbState.users[0].role).toBe("user");
    expect(dbState.users[0].status).toBe("approved");
    expect(dbState.users[0].isActive).toBe(true);
    expect(dbState.users[0].clerkId).toBe("user-clerk-id");
  });


  it("saves and reloads notification preferences for only the authenticated user", async () => {
    seedUser();
    seedUser({ id: 2, clerkId: "other-clerk-id", email: "other@example.com", notificationPreferences: { inAppAlerts: true, smsTexts: true, emails: true, inAppAlertMode: "sound" } });
    const prefs = { inAppAlerts: true, smsTexts: false, emails: false, inAppAlertMode: "sound_vibrate" };

    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ notificationPreferences: prefs });

    expect(res.status).toBe(200);
    expect(res.body.notificationPreferences).toEqual(prefs);
    expect(dbState.users[0].notificationPreferences).toEqual(prefs);
    expect(dbState.users[1].notificationPreferences).toEqual({ inAppAlerts: true, smsTexts: true, emails: true, inAppAlertMode: "sound" });

    const reload = await supertest(buildApp()).get("/api/users/me");
    expect(reload.body.notificationPreferences).toEqual(prefs);
  });

  it("rejects unknown notification preference fields", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ notificationPreferences: { inAppAlerts: true, smsTexts: true, emails: true, inAppAlertMode: "sound", userId: 2 } });
    expect(res.status).toBe(400);
    expect(dbState.users[0].notificationPreferences).toBeUndefined();
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

  it("rejects direct avatar URLs and data URIs", async () => {
    seedUser();
    const res = await supertest(buildApp())
      .patch("/api/users/me")
      .send({ avatarUrl: "data:image/png;base64,AAAA" });
    expect(res.status).toBe(400);
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

describe("PATCH /api/admin/users/:id/profile", () => {
  function seedManagerAndTarget(targetTenant = 5, targetRole = "user") {
    seedUser({ role: "admin", tenantId: 5 });
    seedUser({ id: 2, clerkId: "member-clerk-id", email: "member@example.com", firstName: "Member", role: targetRole, tenantId: targetTenant });
  }

  it("allows a same-tenant admin to edit permitted fields, stores the audit, and supports photo upload", async () => {
    seedManagerAndTarget();
    const imageId = "f2862f21-4f21-48f2-8cad-79bde3f2c2c3";
    const res = await supertest(buildApp()).patch("/api/admin/users/2/profile").send({
      firstName: "Updated Member", contactPhone: "+15551234567", profileImageUploadId: imageId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dbState.users[1]).toMatchObject({ firstName: "Updated Member", contactPhone: "+15551234567", avatarUrl: `/api/profile-images/${imageId}` });
    expect(assertTemporaryProfileImage).toHaveBeenCalledWith(imageId, "member@example.com");
    expect(finalizeProfileImage).toHaveBeenCalledWith(imageId);
    expect(dbState.audits).toContainEqual(expect.objectContaining({ action: "UPDATE_MEMBER_PROFILE", tenantId: 5, resourceId: "2", metadata: { fields: ["firstName", "contactPhone", "avatarUrl"] } }));
  });

  it("denies cross-tenant profile edits", async () => {
    seedManagerAndTarget(9);
    const res = await supertest(buildApp()).patch("/api/admin/users/2/profile").send({ firstName: "Nope" });
    expect(res.status).toBe(403);
    expect(dbState.users[1].firstName).toBe("Member");
    expect(dbState.audits).toHaveLength(0);
  });

  it("rejects protected membership and role fields and refuses edits of equal or higher roles", async () => {
    seedManagerAndTarget();
    const forged = await supertest(buildApp()).patch("/api/admin/users/2/profile").send({ firstName: "Nope", role: "admin", status: "approved", tenantId: 99, organizationId: 99 });
    expect(forged.status).toBe(400);
    expect(dbState.users[1].firstName).toBe("Member");
    seedUser({ id: 3, clerkId: "peer-admin", email: "peer@example.com", role: "admin", tenantId: 5 });
    const peer = await supertest(buildApp()).patch("/api/admin/users/3/profile").send({ firstName: "Nope" });
    expect(peer.status).toBe(403);
  });
});
