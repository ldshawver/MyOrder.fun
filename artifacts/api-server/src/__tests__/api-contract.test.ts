/**
 * API contract tests — every /api/* response is JSON.
 *
 * Verifies:
 *  1. Unknown /api/* routes return JSON 404.
 *  2. Synchronous throws return JSON 500.
 *  3. Asynchronous throws (rejected promises) return JSON 500.
 *  4. Malformed JSON request bodies return JSON 400 (not HTML).
 */

import { describe, it, expect, vi } from "vitest";

// Mock dependencies that have side effects on import so app.ts can load
// in the test environment without real Clerk creds or DB connections.
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({})),
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/api/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/printService", () => ({
  startPrintWorker: () => {},
}));

vi.mock("@workspace/db", () => {
  const cols = (names: string[]) => Object.fromEntries(names.map(n => [n, `${n}_col`]));
  return {
    db: {
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
      select: vi.fn(() => {
        const p = Promise.resolve([]) as unknown as Record<string, unknown>;
        p.from = vi.fn(() => { const p2 = Promise.resolve([]) as unknown as Record<string, unknown>; p2.where = vi.fn(() => { const p3 = Promise.resolve([]) as unknown as Record<string, unknown>; p3.limit = vi.fn(() => Promise.resolve([])); p3.orderBy = vi.fn(() => Promise.resolve([])); return p3; }); p2.limit = vi.fn(() => Promise.resolve([])); p2.orderBy = vi.fn(() => Promise.resolve([])); return p2; }); return p; }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: () => Promise.resolve([]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: () => Promise.resolve([]) })) })) })),
      delete: vi.fn(),
    },
    usersTable: cols(["clerkId", "id", "email", "firstName", "lastName", "role", "status", "isActive"]),
    catalogItemsTable: cols(["id", "name", "alavontName", "isWooManaged", "isLocalAlavont", "isAvailable", "alavontCategory", "category", "stockUnit", "inventoryAmount", "stockQuantity", "parLevel", "alavontId", "externalMenuId", "costBasis", "price"]),
    ordersTable: cols(["id", "customerId", "assignedShiftId"]),
    orderItemsTable: cols(["orderId"]),
    notificationsTable: cols(["id"]),
    labTechShiftsTable: cols(["id", "techId", "status", "tenantId"]),
    shiftInventoryItemsTable: cols(["shiftId", "displayOrder"]),
    inventoryTemplatesTable: cols(["id", "tenantId", "itemName", "sectionName", "rowType", "unitType", "startingQuantityDefault", "displayOrder", "isActive", "catalogItemId", "deductionQuantityPerSale", "currentStock", "menuPrice", "payoutPrice", "parLevel", "alavontId"]),
    csrBoxesTable: cols(["id", "tenantId", "slug", "label", "isActive", "displayOrder", "description", "location"]),
    inventoryLocationsTable: cols(["id", "tenantId", "name", "type", "csrBoxId", "isActive", "displayOrder", "createdAt", "updatedAt", "inventoryKind", "quarantineStatus", "quarantineReason"]),
    inventoryBalancesTable: cols(["id", "tenantId", "productId", "locationId", "quantityOnHand", "parLevel", "updatedAt", "inventoryKind", "quarantineStatus", "quarantineReason"]),
    auditLogsTable: {},
    adminSettingsTable: cols(["tenantId", "pettyCash"]),
    feedbackTicketsTable: cols(["id", "tenantId"]),
    feedbackTicketCommentsTable: cols(["id"]),
    onboardingRequestsTable: cols(["id"]),
    tenantsTable: cols(["id"]),
    printPrintersTable: cols(["id"]),
    printBridgeProfilesTable: cols(["id"]),
    printJobsTable: cols(["id"]),
    printJobAttemptsTable: cols(["id"]),
    printSettingsTable: cols(["id"]),
    operatorPrintProfilesTable: cols(["id"]),
    printTemplatesTable: cols(["id"]),
    printAssetsTable: cols(["id"]),
  };
});

// Bypass the auth middleware chain so unknown /api/* paths actually reach
// the global JSON 404 handler instead of being short-circuited at 401. The
// production behaviour of those middlewares (returning JSON 401) is covered
// by approval-gate.test.ts; this suite is specifically about the contract
// of the global 404 / error / body-parse handlers in app.ts.
vi.mock("../lib/auth", () => {
  const noop = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    requireAuth: noop,
    loadDbUser: noop,
    requireDbUser: noop,
    requireApproved: noop,
    requireRole: () => noop,
  };
});

vi.mock("../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn().mockResolvedValue(1),
}));


vi.mock("../lib/checkoutNormalizer", () => ({
  normalizeCheckoutCart: vi.fn().mockResolvedValue([]),
  buildMerchantPayloadLines: vi.fn().mockReturnValue([]),
}));

vi.mock("../lib/printRouter", () => ({
  selectActiveOperator: vi.fn().mockResolvedValue(null),
  probePrinter: vi.fn().mockResolvedValue(false),
  resolveReceiptPrinters: vi.fn().mockResolvedValue([]),
  resolveLabelPrinter: vi.fn().mockResolvedValue(null),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  or: vi.fn((...args) => args),
  ilike: vi.fn((col, val) => ({ col, val })),
  like: vi.fn((col, val) => ({ col, val })),
  asc: vi.fn(c => c),
  desc: vi.fn(c => c),
  gte: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

import supertest from "supertest";
import app from "../app";

describe("API contract — /api/* always returns JSON (real assembled app)", () => {
  it("unknown /api/* path that bypasses auth gates → JSON 404 with documented {error, path}", async () => {
    // /api/__contract/known-prefix is mounted (test-only) with no sub-routes,
    // so this URL falls straight through to the /api JSON 404 handler.
    const target = "/api/__contract/known-prefix/does-not-exist";
    const res = await supertest(app).get(target);
    if (res.status === 500) console.error("DEBUG 500 body:", JSON.stringify(res.body));
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "Not found",
      path: target,
    });
  });

  it("any unknown /api/* path → JSON 404 with documented body shape", async () => {
    const target = "/api/this-route-does-not-exist";
    const res = await supertest(app).get(target);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ error: "Not found", path: target });
  });

  it("malformed JSON body → JSON 400, never HTML", async () => {
    const res = await supertest(app)
      .post("/api/__contract/sync-throw")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("Invalid JSON body");
  });
});

describe("API contract — global error middleware (real assembled app)", () => {
  it("synchronous throw → JSON 500 via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/sync-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("sync boom");
  });

  it("asynchronous throw → JSON 500 via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/async-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("async boom");
  });

  it("error with custom status → that status, JSON body, via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/custom-status");
    expect(res.status).toBe(418);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("teapot");
  });
});
