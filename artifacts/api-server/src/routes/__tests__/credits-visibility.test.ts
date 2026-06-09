/**
 * Credit visibility permission tests
 *
 * Verifies that:
 *  - Any authenticated user (any status, any role) can GET /credits/me
 *  - customer (pending) views own credit: 200
 *  - customer (approved) views own credit: 200
 *  - CSR views own credit: 200
 *  - supervisor / admin views own credit: 200
 *  - customer cannot view another user's credit via /admin/credits/:userId: 403
 *  - CSR cannot view another user's credit: 403
 *  - admin / global_admin can view another user's credit: 200
 *  - unauthenticated (no session) is blocked: 401
 *
 * Strategy:
 *  - Mock @clerk/express, @workspace/db, and the auth lib (../../lib/auth)
 *    to control the actor identity without fighting loadDbUser.
 *  - Import the real credits router so the route handler logic is exercised.
 *  - Use supertest to fire HTTP requests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ---------------------------------------------------------------------------
// Shared actor state — mutated per-test
// ---------------------------------------------------------------------------
let currentActor: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Mock @clerk/express
// ---------------------------------------------------------------------------
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => (currentActor ? { userId: "test-clerk-id" } : {})),
  clerkClient: { users: { getUser: vi.fn() } },
}));

// ---------------------------------------------------------------------------
// Mock the auth lib — gives us full per-test control over middleware
// ---------------------------------------------------------------------------
vi.mock("../../lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/auth")>();
  return {
    requireAuth: (req: never, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!currentActor) { res.status(401).json({ error: "Unauthorized" }); return; }
      next();
    },
    loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => {
      req.dbUser = currentActor ?? undefined;
      next();
    },
    requireDbUser: (req: { dbUser?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!req.dbUser) { res.status(401).json({ error: "User profile not found" }); return; }
      next();
    },
    requireApproved: (req: { dbUser?: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const user = req.dbUser;
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      const role = real.normalizeRole(user.role);
      if ((real.STAFF_ROLES as readonly string[]).includes(role)) { next(); return; }
      if (user.status !== "approved") { res.status(403).json({ error: "Account pending approval" }); return; }
      next();
    },
    requireRole: (...roles: string[]) => (req: { dbUser?: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const user = req.dbUser;
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      const actorRole = real.normalizeRole(user.role);
      const allowed = roles.map(r => real.normalizeRole(r));
      const ok = allowed.includes(actorRole) || (actorRole === "global_admin" && allowed.includes("admin"));
      if (!ok) { res.status(403).json({ error: "Forbidden: insufficient role" }); return; }
      next();
    },
    normalizeRole: real.normalizeRole,
    STAFF_ROLES: real.STAFF_ROLES,
    writeAuditLog: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock @workspace/db
// ---------------------------------------------------------------------------
const fakeCreditRow = {
  id: 1,
  userId: 99,
  tenantId: 1,
  amount: "25.00",
  reason: "Welcome credit",
  source: "admin_adjustment",
  createdBy: 1,
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

const fakeTargetUser = {
  id: 99,
  clerkId: "other-clerk-id",
  email: "other@example.com",
  role: "user",
  status: "approved",
  isActive: true,
  tenantId: 1,
};

vi.mock("@workspace/db", () => {
  const userCreditsTable = { userId: "userId_col", id: "id_col", createdAt: "createdAt_col" };
  const usersTable = { id: "id_col", clerkId: "clerkId_col", createdAt: "createdAt_col" };
  const auditLogsTable = {};

  const db = {
    execute: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([fakeCreditRow])) })),
    })),
  };

  return { db, userCreditsTable, usersTable, auditLogsTable };
});

vi.mock("../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/clerkSync", () => ({
  readClerkPublicMetadata: vi.fn(() => ({ role: undefined, status: undefined })),
}));

// ---------------------------------------------------------------------------
// Import the real credits router after mocks are hoisted
// ---------------------------------------------------------------------------
const { db, userCreditsTable } = await import("@workspace/db");

// ---------------------------------------------------------------------------
// Helper: set up db.select mock to return per-table rows
// ---------------------------------------------------------------------------
function setupDb(opts: { creditRows?: unknown[]; targetUserRows?: unknown[] } = {}) {
  const { creditRows = [fakeCreditRow], targetUserRows = [fakeTargetUser] } = opts;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: vi.fn((table: unknown) => {
      const isCreditTable = table === userCreditsTable;
      const rows = isCreditTable ? creditRows : targetUserRows;
      const chain: Record<string, unknown> = {};
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => Promise.resolve(rows));
      chain.limit = vi.fn(() => Promise.resolve(rows));
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return chain;
    }),
  }));
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  const { default: creditsRouter } = await import("../../routes/credits");
  app.use(creditsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentActor = null;
});

// ---------------------------------------------------------------------------
// GET /credits/me — self-view
// ---------------------------------------------------------------------------
describe("GET /credits/me — self-view permission", () => {
  it("customer with pending status can view own credit: 200", async () => {
    currentActor = { id: 42, role: "user", status: "pending", isActive: true };
    setupDb({ creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("balance");
    expect(res.body).toHaveProperty("entries");
  });

  it("customer with approved status can view own credit: 200", async () => {
    currentActor = { id: 42, role: "user", status: "approved", isActive: true };
    setupDb({ creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(200);
    expect(typeof res.body.balance).toBe("number");
    expect(res.body.balance).toBeCloseTo(25);
  });

  it("CSR can view own credit: 200", async () => {
    currentActor = { id: 7, role: "customer_service_rep", status: "approved", isActive: true };
    setupDb({ creditRows: [] });
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.entries).toEqual([]);
  });

  it("supervisor (admin role) can view own credit: 200", async () => {
    currentActor = { id: 8, role: "admin", status: "approved", isActive: true };
    setupDb({ creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(200);
  });

  it("global_admin can view own credit: 200", async () => {
    currentActor = { id: 1, role: "global_admin", status: "approved", isActive: true };
    setupDb({ creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(200);
  });

  it("unauthenticated (no session) cannot view credits/me: 401", async () => {
    currentActor = null;
    const res = await supertest(await makeApp()).get("/credits/me");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/credits/:userId — admin-only per-user credit view
// ---------------------------------------------------------------------------
describe("GET /admin/credits/:userId — admin-only per-user credit view", () => {
  it("customer cannot view another user's credit: 403", async () => {
    currentActor = { id: 42, role: "user", status: "approved", isActive: true };
    setupDb({ targetUserRows: [fakeTargetUser], creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/admin/credits/99");
    expect(res.status).toBe(403);
  });

  it("CSR cannot view another user's credit: 403", async () => {
    currentActor = { id: 7, role: "customer_service_rep", status: "approved", isActive: true };
    setupDb({ targetUserRows: [fakeTargetUser], creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/admin/credits/99");
    expect(res.status).toBe(403);
  });

  it("admin can view another user's credit: 200", async () => {
    currentActor = { id: 8, role: "admin", status: "approved", isActive: true };
    setupDb({ targetUserRows: [fakeTargetUser], creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/admin/credits/99");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("userId", 99);
    expect(res.body).toHaveProperty("balance");
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ amount: 25, reason: "Welcome credit" });
  });

  it("global_admin can view another user's credit: 200", async () => {
    currentActor = { id: 1, role: "global_admin", status: "approved", isActive: true };
    setupDb({ targetUserRows: [fakeTargetUser], creditRows: [fakeCreditRow] });
    const res = await supertest(await makeApp()).get("/admin/credits/99");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("userId", 99);
    expect(res.body.entries).toHaveLength(1);
  });

  it("admin gets 404 when target user does not exist: 404", async () => {
    currentActor = { id: 8, role: "admin", status: "approved", isActive: true };
    setupDb({ targetUserRows: [], creditRows: [] });
    const res = await supertest(await makeApp()).get("/admin/credits/9999");
    expect(res.status).toBe(404);
  });
});
