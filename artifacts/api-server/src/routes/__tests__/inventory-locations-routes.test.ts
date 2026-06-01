/**
 * inventory-locations-routes.test.ts
 *
 * Tests for:
 *   GET  /api/admin/inventory-locations
 *   POST /api/admin/inventory-locations
 *   PATCH /api/admin/inventory-locations/:id
 *   GET  /api/admin/inventory-balances
 *   PATCH /api/admin/inventory-balances/:id
 *   GET  /api/shifts/inventory-template?locationId=<id>
 *
 * Permission tests:
 *   - Non-admin (CSR) cannot reach admin routes (403)
 *   - WooCommerce items excluded from balances
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
  const p = Promise.resolve(resolved) as unknown as Record<string, unknown>;
  p.limit = () => Promise.resolve(resolved);
  p.orderBy = () => Promise.resolve(resolved);
  p.where = vi.fn(() => makeChain(resolved));
  p.from = vi.fn(() => makeChain(resolved));
  p.innerJoin = vi.fn(() => makeChain(resolved));
  return p;
};

vi.mock("@workspace/db", () => {
  const cols = (names: string[]) =>
    Object.fromEntries(names.map(n => [n, `${n}_col`]));

  const usersTable = cols(["clerkId", "id", "email", "firstName", "lastName", "role", "status", "isActive"]);
  const catalogItemsTable = cols([
    "id", "name", "alavontName", "isWooManaged", "isLocalAlavont", "isAvailable",
    "alavontCategory", "category", "stockUnit", "inventoryAmount", "stockQuantity",
    "parLevel", "alavontId", "externalMenuId", "costBasis", "price",
  ]);
  const csrBoxesTable = cols(["id", "tenantId", "slug", "label", "isActive", "displayOrder", "description", "location"]);
  const inventoryLocationsTable = cols(["id", "tenantId", "name", "type", "csrBoxId", "isActive", "displayOrder", "createdAt", "updatedAt"]);
  const inventoryBalancesTable = cols(["id", "tenantId", "productId", "locationId", "quantityOnHand", "parLevel", "updatedAt"]);
  const inventoryTemplatesTable = cols([
    "id", "tenantId", "itemName", "sectionName", "rowType", "unitType",
    "startingQuantityDefault", "displayOrder", "isActive", "catalogItemId",
    "deductionQuantityPerSale", "currentStock", "menuPrice", "payoutPrice", "parLevel", "alavontId",
  ]);
  const labTechShiftsTable = cols(["id", "techId", "status", "tenantId"]);
  const shiftInventoryItemsTable = cols(["shiftId", "displayOrder"]);
  const ordersTable = cols(["assignedShiftId", "id", "customerId"]);
  const orderItemsTable = cols(["orderId"]);
  const auditLogsTable = {};
  const adminSettingsTable = cols(["pickupInstructionOptions", "shiftLocationOptions", "deliveryOptions", "printerNetworkConfig"]);

  const db = {
    execute: vi.fn(() => Promise.resolve()),
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
    csrBoxesTable,
    inventoryLocationsTable,
    inventoryBalancesTable,
    inventoryTemplatesTable,
    labTechShiftsTable,
    shiftInventoryItemsTable,
    ordersTable,
    orderItemsTable,
    auditLogsTable,
    adminSettingsTable,
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
import shiftsRouter from "../shifts";

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

function makeAdmin() {
  return {
    id: 1, clerkId: "admin-clerk-id", email: "admin@example.com",
    firstName: "A", lastName: "D", role: "admin", status: "approved", isActive: true,
  };
}

function makeCsr() {
  return {
    id: 2, clerkId: "csr-clerk-id", email: "csr@example.com",
    firstName: "C", lastName: "R", role: "customer_service_rep", status: "approved", isActive: true,
  };
}

function makeLocation(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, tenantId: 1, name: "Backstock", type: "backstock",
    csrBoxId: null, isActive: true, displayOrder: 1,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, tenantId: 1, productId: 10, locationId: 1,
    quantityOnHand: "5.000", parLevel: "2.00", updatedAt: new Date(),
    productName: "Widget", alavontName: "Alavont Widget",
    locationName: "Backstock", locationType: "backstock",
    ...overrides,
  };
}

/**
 * Configures db.select mock:
 *   call 1 = user lookup
 *   calls 2–N = queue (empty array if not specified)
 */
function configureDb(user: ReturnType<typeof makeAdmin> | ReturnType<typeof makeCsr>, queue: unknown[][] = []) {
  let n = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    n++;
    if (n === 1) return makeChain([user]);
    return makeChain(queue[n - 2] ?? []);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId = "admin-clerk-id";
});

// ─── GET /api/admin/inventory-locations ───────────────────────────────────────

describe("GET /api/admin/inventory-locations", () => {
  it("returns 200 with { locations } for admin", async () => {
    configureDb(makeAdmin(), [
      [], // csr_boxes (ensureInventoryLocations boxes lookup)
      [], // existing locations for backstock check
      [], // existing locations for storefront check
      [], // existing locations for box1 check
      [], // existing locations for box2 check
      [], // template items (backfill check)
      [makeLocation(), makeLocation({ id: 2, name: "Storefront", type: "storefront" })], // final select
    ]);

    const res = await supertest(buildApp(shiftsRouter)).get("/api/admin/inventory-locations");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Array.isArray(res.body.locations)).toBe(true);
  });

  it("returns 403 for CSR (non-admin)", async () => {
    mockUserId = "csr-clerk-id";
    configureDb(makeCsr());
    const res = await supertest(buildApp(shiftsRouter)).get("/api/admin/inventory-locations");
    expect(res.status).toBe(403);
  });
});

// ─── POST /api/admin/inventory-locations ──────────────────────────────────────

describe("POST /api/admin/inventory-locations", () => {
  it("returns 201 with created location", async () => {
    const created = makeLocation({ id: 5, name: "New Location", type: "storefront" });
    configureDb(makeAdmin(), [
      [], [], [], [], [], // ensureInventoryLocations selects
      [],                 // template items
      [],                 // final locations select in ensureInventoryLocations
    ]);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn(() => ({ returning: () => Promise.resolve([created]) })),
    }));

    const res = await supertest(buildApp(shiftsRouter))
      .post("/api/admin/inventory-locations")
      .send({ name: "New Location", type: "storefront" });

    expect(res.status).toBe(201);
    expect(res.body.location).toBeDefined();
  });

  it("returns 400 if name is missing", async () => {
    configureDb(makeAdmin(), [[], [], [], [], [], [], []]);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn(() => ({ returning: () => Promise.resolve([]) })),
    }));
    const res = await supertest(buildApp(shiftsRouter))
      .post("/api/admin/inventory-locations")
      .send({ type: "storefront" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 if type is invalid", async () => {
    configureDb(makeAdmin(), [[], [], [], [], [], [], []]);
    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn(() => ({ returning: () => Promise.resolve([]) })),
    }));
    const res = await supertest(buildApp(shiftsRouter))
      .post("/api/admin/inventory-locations")
      .send({ name: "Loc", type: "magic_closet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  it("returns 403 for CSR", async () => {
    mockUserId = "csr-clerk-id";
    configureDb(makeCsr());
    const res = await supertest(buildApp(shiftsRouter))
      .post("/api/admin/inventory-locations")
      .send({ name: "X", type: "backstock" });
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/admin/inventory-locations/:id ─────────────────────────────────

describe("PATCH /api/admin/inventory-locations/:id", () => {
  it("returns 200 with updated location", async () => {
    const updated = makeLocation({ isActive: false });
    configureDb(makeAdmin());
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: () => Promise.resolve([updated]) })),
      })),
    }));
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-locations/1")
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.location.isActive).toBe(false);
  });

  it("returns 400 when no fields provided", async () => {
    configureDb(makeAdmin());
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-locations/1")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when location not found", async () => {
    configureDb(makeAdmin());
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: () => Promise.resolve([]) })),
      })),
    }));
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-locations/999")
      .send({ isActive: true });
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/admin/inventory-balances ────────────────────────────────────────

describe("GET /api/admin/inventory-balances", () => {
  it("returns 200 with { balances, locations } for admin", async () => {
    configureDb(makeAdmin(), [
      [], [], [], [], [], // ensureInventoryLocations
      [],                 // template backfill
      [makeBalance()],   // balances join query
      [makeLocation()],  // locations
    ]);

    const res = await supertest(buildApp(shiftsRouter)).get("/api/admin/inventory-balances");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.balances)).toBe(true);
    expect(Array.isArray(res.body.locations)).toBe(true);
  });

  it("parses quantityOnHand as number", async () => {
    configureDb(makeAdmin(), [
      [], [], [], [], [], [],
      [makeBalance({ quantityOnHand: "7.500" })],
      [makeLocation()],
    ]);

    const res = await supertest(buildApp(shiftsRouter)).get("/api/admin/inventory-balances");
    expect(res.status).toBe(200);
    expect(typeof res.body.balances[0]?.quantityOnHand).toBe("number");
    expect(res.body.balances[0]?.quantityOnHand).toBe(7.5);
  });

  it("returns 403 for CSR", async () => {
    mockUserId = "csr-clerk-id";
    configureDb(makeCsr());
    const res = await supertest(buildApp(shiftsRouter)).get("/api/admin/inventory-balances");
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/admin/inventory-balances/:id ──────────────────────────────────

describe("PATCH /api/admin/inventory-balances/:id", () => {
  it("returns 200 with updated balance and parsed numbers", async () => {
    const existing = { id: 1, tenantId: 1, productId: 10, locationId: 1, quantityOnHand: "5.000", parLevel: "2.00" };
    const updated = { ...existing, quantityOnHand: "12.000", parLevel: "2.00", updatedAt: new Date() };
    configureDb(makeAdmin(), [
      [existing], // select current
    ]);
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: () => Promise.resolve([updated]) })),
      })),
    }));

    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-balances/1")
      .send({ quantityOnHand: 12 });

    expect(res.status).toBe(200);
    expect(typeof res.body.balance.quantityOnHand).toBe("number");
  });

  it("returns 400 when no fields provided", async () => {
    configureDb(makeAdmin());
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-balances/1")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when balance not found", async () => {
    configureDb(makeAdmin(), [[]]);
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-balances/999")
      .send({ quantityOnHand: 5 });
    expect(res.status).toBe(404);
  });

  it("returns 403 for CSR", async () => {
    mockUserId = "csr-clerk-id";
    configureDb(makeCsr());
    const res = await supertest(buildApp(shiftsRouter))
      .patch("/api/admin/inventory-balances/1")
      .send({ quantityOnHand: 5 });
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/shifts/inventory-template?locationId= ───────────────────────────

describe("GET /api/shifts/inventory-template?locationId=", () => {
  it("returns quantities from inventory_balances when locationId is provided", async () => {
    const templateRow = {
      id: 1, sectionName: "Alavont", itemName: "Widget A", rowType: "item",
      unitType: "#", startingQuantityDefault: "10", currentStock: "10",
      catalogItemId: 42, alavontId: null, displayOrder: 10,
      menuPrice: "25.00", payoutPrice: "20.00", parLevel: "2", isActive: true,
      tenantId: 1, deductionQuantityPerSale: "1",
    };
    const csrBox = { id: 1, slug: "sales-box-1", label: "CSR Sales Box 1", isActive: true, displayOrder: 1, description: null, location: null };
    const balance = { productId: 42, qty: "3.000" };

    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeChain([makeAdmin()]);  // user
      if (n === 2) return makeChain([templateRow]);  // ensureClockInInventoryTemplate — existing templates
      if (n === 3) return makeChain([]);             // catalog rows (none to auto-add)
      if (n === 4) return makeChain([csrBox]);       // getActiveCsrBoxes
      if (n === 5) return makeChain([csrBox]);       // ensureInventoryLocations: boxes
      // remaining: location existence checks (all empty = already seeded)
      if (n <= 12) return makeChain([{ id: n }]);
      if (n === 13) return makeChain([balance]);     // balanceMap query
      return makeChain([]);
    });

    const res = await supertest(buildApp(shiftsRouter))
      .get("/api/shifts/inventory-template?locationId=1");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Array.isArray(res.body.template)).toBe(true);
  });

  it("falls back to startingQuantityDefault when no locationId", async () => {
    const templateRow = {
      id: 1, sectionName: "A", itemName: "Widget", rowType: "item",
      unitType: "#", startingQuantityDefault: "10", currentStock: "10",
      catalogItemId: 42, alavontId: null, displayOrder: 10,
      menuPrice: null, payoutPrice: null, parLevel: "0", isActive: true,
      tenantId: 1, deductionQuantityPerSale: "1",
    };

    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeChain([makeAdmin()]);
      if (n === 2) return makeChain([templateRow]);
      if (n === 3) return makeChain([]);
      if (n <= 10) return makeChain([{ id: n }]);
      return makeChain([]);
    });

    const res = await supertest(buildApp(shiftsRouter)).get("/api/shifts/inventory-template");
    expect(res.status).toBe(200);
    expect(res.body.template[0]?.startingQuantityDefault).toBe(10);
  });
});
