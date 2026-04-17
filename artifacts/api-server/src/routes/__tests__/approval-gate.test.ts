/**
 * Approval-gate integration tests
 *
 * These tests verify that the requireApproved middleware is correctly wired
 * into the catalog, orders, and AI routers, and that the /users/me and
 * /users/sync routes remain accessible to pending users.
 *
 * Strategy:
 *  - Mock @clerk/express so getAuth returns a fake authenticated session.
 *  - Mock @workspace/db so the user-lookup inside loadDbUser resolves to a
 *    controlled fake user (pending or approved).
 *  - Import the real Express routers so the actual middleware stack is exercised.
 *  - Use supertest to fire HTTP requests and assert on the HTTP status codes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ---------------------------------------------------------------------------
// Shared mock state — tests mutate these to switch between user profiles.
// ---------------------------------------------------------------------------
let mockUserId: string | null = "test-clerk-id";
let mockDbUser: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Mock @clerk/express — control which Clerk user is "authenticated"
// ---------------------------------------------------------------------------
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId } : {})),
}));

// ---------------------------------------------------------------------------
// Mock @workspace/db — return the fake user for loadDbUser; return empty
// arrays for all data queries so route handlers don't throw.
// ---------------------------------------------------------------------------
const makeDrizzleChain = (resolvedValue: unknown[]) => {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(resolvedValue);
  // Support: .from().where().limit() | .from().where() | .from().orderBy() | .from()
  chain.where = vi.fn(() => ({ ...chain, limit: terminal, orderBy: () => Promise.resolve(resolvedValue) }));
  chain.limit = terminal;
  chain.orderBy = vi.fn(() => Promise.resolve(resolvedValue));
  chain.from = vi.fn(() => chain);
  return chain;
};

vi.mock("@workspace/db", () => {
  const usersTable = {
    clerkId: "clerkId_col",
    id: "id_col",
    email: "email_col",
    status: "status_col",
    role: "role_col",
  };
  const catalogItemsTable = { id: "catalog_id_col", name: "name_col" };
  const ordersTable = { id: "order_id_col", customerId: "customerId_col", tenantId: "tenantId_col" };
  const orderItemsTable = {};
  const orderNotesTable = {};
  const notificationsTable = {};
  const usersTableSelect = {
    firstName: "firstName_col",
    lastName: "lastName_col",
    email: "email_col",
  };
  const labTechShiftsTable = {};
  const inventoryTemplatesTable = {};

  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  return {
    db,
    usersTable,
    catalogItemsTable,
    ordersTable,
    orderItemsTable,
    orderNotesTable,
    notificationsTable,
    labTechShiftsTable,
    inventoryTemplatesTable,
    usersTableSelect,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  ilike: vi.fn((col, val) => ({ col, val })),
  asc: vi.fn((col) => col),
  desc: vi.fn((col) => col),
  gte: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

// Stub heavy route dependencies so they don't need real config
vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn().mockResolvedValue(1),
}));

vi.mock("../../lib/sms", () => ({
  sendSms: vi.fn(),
  smsOrderConfirmation: vi.fn(),
  smsNewOrderAlert: vi.fn(),
  smsStatusUpdate: vi.fn(),
  smsTrackingReady: vi.fn(),
  smsAccountApproved: vi.fn(),
}));

vi.mock("../../lib/checkoutNormalizer", () => ({
  normalizeCheckoutCart: vi.fn().mockResolvedValue([]),
  buildMerchantPayloadLines: vi.fn().mockReturnValue([]),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
}));

vi.mock("../../lib/printService", () => ({}));

// ---------------------------------------------------------------------------
// Import mocked db so we can configure it per test
// ---------------------------------------------------------------------------
import { db } from "@workspace/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePendingUser() {
  return {
    id: 10,
    clerkId: "test-clerk-id",
    email: "pending@example.com",
    firstName: "Pending",
    lastName: "User",
    role: "user",
    status: "pending",
    isActive: true,
    mfaEnabled: false,
    contactPhone: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeApprovedUser() {
  return { ...makePendingUser(), id: 11, email: "approved@example.com", status: "approved" };
}

/**
 * Set up the db.select mock so the first call (user lookup) resolves with
 * the given user, and subsequent calls (data queries) resolve with [].
 */
function configureDbForUser(user: Record<string, unknown> | null) {
  mockDbUser = user;
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    const resolvedValue = callCount === 1 && user ? [user] : [];
    return makeDrizzleChain(resolvedValue);
  });
}

// ---------------------------------------------------------------------------
// Import real routers AFTER mocks are in place
// ---------------------------------------------------------------------------
import catalogRouter from "../catalog";
import ordersRouter from "../orders";
import aiRouter from "../ai";
import usersRouter from "../users";

function buildApp(...routers: express.Router[]) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use("/api", r);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Approval gate — catalog endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = "test-clerk-id";
  });

  it("blocks a pending user with HTTP 403", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(catalogRouter);
    const res = await supertest(app).get("/api/catalog");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pending approval/i);
  });

  it("allows an approved user through with HTTP 200", async () => {
    configureDbForUser(makeApprovedUser());
    const app = buildApp(catalogRouter);
    const res = await supertest(app).get("/api/catalog");
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockUserId = null;
    configureDbForUser(null);
    const app = buildApp(catalogRouter);
    const res = await supertest(app).get("/api/catalog");
    expect(res.status).toBe(401);
  });
});

describe("Approval gate — orders endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = "test-clerk-id";
  });

  it("blocks a pending user with HTTP 403", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(ordersRouter);
    const res = await supertest(app).get("/api/orders");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pending approval/i);
  });

  it("allows an approved user through with HTTP 200", async () => {
    configureDbForUser(makeApprovedUser());
    const app = buildApp(ordersRouter);
    const res = await supertest(app).get("/api/orders");
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockUserId = null;
    configureDbForUser(null);
    const app = buildApp(ordersRouter);
    const res = await supertest(app).get("/api/orders");
    expect(res.status).toBe(401);
  });
});

describe("Approval gate — AI endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = "test-clerk-id";
  });

  it("blocks a pending user with HTTP 403 on /ai/chat", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(aiRouter);
    const res = await supertest(app).post("/api/ai/chat").send({ messages: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pending approval/i);
  });

  it("blocks a pending user with HTTP 403 on /ai/upsell", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(aiRouter);
    const res = await supertest(app).post("/api/ai/upsell").send({ currentItems: [] });
    expect(res.status).toBe(403);
  });

  it("allows an approved user past the approval gate on /ai/chat (not 403)", async () => {
    configureDbForUser(makeApprovedUser());
    const app = buildApp(aiRouter);
    // Not mocking OpenAI — response won't be 200 but must not be 403
    const res = await supertest(app).post("/api/ai/chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).not.toBe(403);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockUserId = null;
    configureDbForUser(null);
    const app = buildApp(aiRouter);
    const res = await supertest(app).post("/api/ai/chat").send({});
    expect(res.status).toBe(401);
  });
});

describe("Approval gate — users exempted routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = "test-clerk-id";
  });

  it("allows a pending user to access GET /users/me (exempted)", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(usersRouter);
    const res = await supertest(app).get("/api/users/me");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("allows a pending user to access POST /users/sync (exempted)", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(usersRouter);
    const res = await supertest(app).post("/api/users/sync");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("blocks a pending user from GET /users (non-exempted) with 403", async () => {
    configureDbForUser(makePendingUser());
    const app = buildApp(usersRouter);
    const res = await supertest(app).get("/api/users");
    expect(res.status).toBe(403);
  });

  it("allows an approved user to see their own profile", async () => {
    configureDbForUser(makeApprovedUser());
    const app = buildApp(usersRouter);
    const res = await supertest(app).get("/api/users/me");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });
});
