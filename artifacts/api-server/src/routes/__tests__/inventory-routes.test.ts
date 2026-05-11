/**
 * Inventory route JSON-contract tests
 *
 * Asserts that the two endpoints the admin Inventory page calls always return
 * `application/json`, never an HTML stack trace or SPA fallback page:
 *
 *   GET  /api/admin/inventory
 *   POST /api/admin/inventory-template/seed
 *
 * Covers both the happy path and a forced-error path (db throws). The forced
 * error must propagate through the same global JSON error handler used by the
 * production app (see app.ts) so the frontend's `await res.json()` never
 * crashes on `Unexpected token '<'`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type ErrorRequestHandler, type Router } from "express";
import supertest from "supertest";

let mockUserId: string | null = "admin-clerk-id";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId } : {})),
}));

const makeChain = (resolved: unknown[]): Record<string, unknown> => {
  const promise = Promise.resolve(resolved) as unknown as Record<string, unknown>;
  promise.limit = () => Promise.resolve(resolved);
  promise.orderBy = () => Promise.resolve(resolved);
  promise.where = vi.fn(() => makeChain(resolved));
  promise.from = vi.fn(() => makeChain(resolved));
  return promise;
};

vi.mock("@workspace/db", () => {
  const cols = (names: string[]) =>
    Object.fromEntries(names.map(n => [n, `${n}_col`]));

  const usersTable = cols(["clerkId", "id", "email", "firstName", "lastName", "role", "status", "isActive"]);
  const catalogItemsTable = cols([
    "id", "name", "alavontName", "luciferCruzName", "category", "alavontCategory",
    "price", "regularPrice", "stockQuantity", "stockUnit", "parLevel", "isAvailable",
  ]);
  const adminSettingsTable = cols(["tenantId", "pettyCash"]);
  const inventoryTemplatesTable = cols([
    "id", "tenantId", "itemName", "sectionName", "rowType", "unitType",
    "startingQuantityDefault", "displayOrder", "isActive", "catalogItemId",
    "deductionQuantityPerSale", "currentStock", "menuPrice", "payoutPrice", "parLevel",
  ]);
  const labTechShiftsTable = cols(["id", "techId", "status", "tenantId", "assignedShiftId"]);
  const shiftInventoryItemsTable = cols(["shiftId", "displayOrder"]);
  const ordersTable = cols(["assignedShiftId", "id", "customerId"]);
  const orderItemsTable = cols(["orderId"]);
  const auditLogsTable = {};

  const db = {
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: () => Promise.resolve([]) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: () => Promise.resolve([]) })),
      })),
    })),
    delete: vi.fn(),
  };

  return {
    db,
    usersTable,
    catalogItemsTable,
    adminSettingsTable,
    inventoryTemplatesTable,
    labTechShiftsTable,
    shiftInventoryItemsTable,
    ordersTable,
    orderItemsTable,
    auditLogsTable,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  asc: vi.fn(c => c),
  desc: vi.fn(c => c),
  sql: vi.fn(),
}));

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn().mockResolvedValue(1),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
}));

import { db } from "@workspace/db";
import inventoryRouter from "../inventory";
import shiftsRouter from "../shifts";

function makeAdmin() {
  return {
    id: 1, clerkId: "admin-clerk-id", email: "admin@example.com",
    firstName: "A", lastName: "D", role: "admin", status: "approved", isActive: true,
  };
}

/**
 * Wires db.select so call #1 (loadDbUser → getOrCreateDbUser) returns the
 * admin user, and subsequent calls follow the supplied queue. Each entry can
 * be a fixed result array, or `"throw"` to simulate a DB failure on that
 * specific call.
 */
function configureDb(queue: Array<unknown[] | "throw">) {
  let n = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    n++;
    if (n === 1) return makeChain([makeAdmin()]);
    const next = queue[n - 2];
    if (next === "throw") throw new Error("simulated db failure");
    return makeChain(next ?? []);
  });
}

// JSON error handler matching the production one in app.ts. Mounting it here
// lets us verify that thrown errors come back as JSON, not HTML.
const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return;
  const status = (err as { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  res.status(status).json({ error: message });
};

function buildApp(router: Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", router);
  app.use(jsonErrorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId = "admin-clerk-id";
});

describe("GET /api/admin/inventory — JSON contract", () => {
  it("returns application/json with { items, pettyCash } on success", async () => {
    configureDb([
      // catalog items query
      [
        {
          id: 1, name: "Item A", alavontName: null, luciferCruzName: null,
          category: "Stimulants", alavontCategory: null,
          price: "10.00", regularPrice: "12.00",
          stockQuantity: "5", stockUnit: "#", parLevel: "2", isAvailable: true,
        },
      ],
      // admin settings query
      [{ pettyCash: "100.00" }],
    ]);

    const res = await supertest(buildApp(inventoryRouter)).get("/api/admin/inventory");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0]).toMatchObject({
      id: 1, name: "Item A", stockQuantity: 5, stockUnit: "#", parLevel: 2,
    });
    expect(typeof res.body.pettyCash).toBe("number");
  });

  it("returns JSON 500 (never HTML) when the database throws", async () => {
    configureDb(["throw"]);

    const res = await supertest(buildApp(inventoryRouter)).get("/api/admin/inventory");

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/simulated db failure/);
    expect(res.text.startsWith("<")).toBe(false);
  });
});

describe("POST /api/admin/inventory-template/seed — JSON contract", () => {
  it("returns application/json with { inserted, updated } on success", async () => {
    // Existing-rows lookup → empty (everything will be inserted).
    configureDb([[]]);

    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn(() => ({
        returning: () => Promise.resolve([{ id: 1 }]),
      })),
    }));
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    }));

    const res = await supertest(buildApp(shiftsRouter)).post("/api/admin/inventory-template/seed");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(typeof res.body.inserted).toBe("number");
    expect(typeof res.body.updated).toBe("number");
    expect(res.body.inserted).toBeGreaterThan(0);
  });

  it("returns JSON 500 (never HTML) when the database throws", async () => {
    configureDb(["throw"]);

    const res = await supertest(buildApp(shiftsRouter)).post("/api/admin/inventory-template/seed");

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/simulated db failure/);
    expect(res.text.startsWith("<")).toBe(false);
  });
});

describe("Frontend fetch shape — what admin/inventory.tsx expects", () => {
  it("GET /api/admin/inventory body has { items: InvItem[], pettyCash: number }", async () => {
    configureDb([[], [{ pettyCash: "0" }]]);
    const res = await supertest(buildApp(inventoryRouter)).get("/api/admin/inventory");
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("pettyCash");
  });

  it("POST /api/admin/inventory-template/seed body has { inserted, updated }", async () => {
    configureDb([[]]);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn(() => ({ returning: () => Promise.resolve([{ id: 1 }]) })),
    }));
    const res = await supertest(buildApp(shiftsRouter)).post("/api/admin/inventory-template/seed");
    expect(res.body).toHaveProperty("inserted");
    expect(res.body).toHaveProperty("updated");
  });
});
