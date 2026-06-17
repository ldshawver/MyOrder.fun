/**
 * Task #12 — Endpoint-level tests for the order routing/hourglass surface.
 *
 * Verifies, via supertest against the mounted Express router:
 *   1. New customer order picks up the 30-minute default hourglass when no
 *      per-order override is supplied (POST /api/orders).
 *   2. Supervisor PATCH /api/orders/:id/eta updates promisedMinutes and
 *      stamps etaAdjustedBySupervisor=true.
 *   3. POST /api/orders/:id/accept emits an `order.updated` SSE event with
 *      reason="accepted" through the in-process event bus.
 *   4. POST /api/orders/:id/mark-ready emits an `order.ready` SSE event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const dbState: {
  orders: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  shifts: Array<Record<string, unknown>>;
  settings: Array<Record<string, unknown>>;
  tenants: Array<Record<string, unknown>>;
  catalog: Array<Record<string, unknown>>;
  inventoryLocations: Array<Record<string, unknown>>;
  inventoryBalances: Array<Record<string, unknown>>;
  csrBoxes: Array<Record<string, unknown>>;
} = { orders: [], users: [], shifts: [], settings: [], tenants: [], catalog: [], inventoryLocations: [], inventoryBalances: [], csrBoxes: [] };

let mockActor: Record<string, unknown> = {};

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "stub" })),
  clerkClient: { users: {} },
}));

function normalizeTestRole(role: string | undefined) {
  if (role === "global_admin") return "global_admin";
  if (role === "admin" || role === "supervisor") return "admin";
  if (
    role === "customer_service_rep" ||
    role === "business_sitter" ||
    role === "sales_rep" ||
    role === "lab_tech" ||
    role === "lab_technician"
  ) return "customer_service_rep";
  return "user";
}

vi.mock("../../lib/auth", () => ({
  normalizeRole: normalizeTestRole,
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { dbUser: Record<string, unknown> }).dbUser = mockActor;
    next();
  },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = (req as unknown as { dbUser?: { role: string } }).dbUser;
    const allowed = roles.map(normalizeTestRole);
    const actorRole = normalizeTestRole(u?.role);
    const hasRole = allowed.includes(actorRole) || (actorRole === "global_admin" && allowed.includes("admin"));
    if (!u || !hasRole) { res.status(403).json({ error: "Forbidden" }); return; }
    next();
  },
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: async () => 1 }));
vi.mock("../../lib/checkoutNormalizer", async () => {
  const { z } = await import("zod");
  class CheckoutMappingError extends Error {
    public readonly catalogItemId: number;
    public readonly reason: string;
    constructor(catalogItemId: number, reason: string, message?: string) {
      super(message ?? reason);
      this.name = "CheckoutMappingError";
      this.catalogItemId = catalogItemId;
      this.reason = reason;
    }
  }
  return {
    CheckoutMappingError,
    CartLineInput: z
      .object({ catalogItemId: z.number().int().positive(), quantity: z.number().int().positive() })
      .strict(),
    CHECKOUT_TAX_RATE: 0.08,
    normalizeCheckoutCart: async () => ([
      {
        catalog_item_id: 1,
        source_type: "local_mapped",
        merchant_brand: "alavont",
        catalog_display_name: "Test",
        merchant_name: "Test LC",
        merchant_sku: "LC-TEST",
        receipt_alavont_name: "Test",
        receipt_lucifer_name: "Test LC",
        merchant_image_url: null,
        unit_price: 10,
        quantity: 1,
        line_subtotal: 10,
        alavont_id: null,
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      },
    ]),
    computeCheckoutTotals: (lines: Array<{ line_subtotal: number }>) => {
      const subtotal = lines.reduce((s, l) => s + l.line_subtotal, 0);
      const tax = parseFloat((subtotal * 0.08).toFixed(2));
      return { subtotal, tax, total: subtotal + tax, taxRate: 0.08 };
    },
    buildMerchantPayloadLines: () => [],
    buildReceiptLines: () => [],
  };
});
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@workspace/db", () => {
  type Pred = ((row: Record<string, unknown>) => boolean) | null;
  const ordersTable = { __t: "orders", id: "id", customerId: "customerId", assignedCsrUserId: "assignedCsrUserId", routedAt: "routedAt", acceptedAt: "acceptedAt", estimatedReadyAt: "estimatedReadyAt", status: "status" };
  const usersTable = { __t: "users", id: "id", role: "role", firstName: "firstName", lastName: "lastName", email: "email" };
  const labTechShiftsTable = { __t: "shifts", id: "id", techId: "techId", status: "status", clockedInAt: "clockedInAt" };
  const adminSettingsTable = { __t: "admin_settings" };
  const tenantsTable = { __t: "tenants", id: "id" };
  const orderItemsTable = { __t: "order_items", orderId: "orderId" };
  const catalogItemsTable = { __t: "catalog", id: "id", tenantId: "tenantId", stockQuantity: "stockQuantity", inventoryAmount: "inventoryAmount" };
  const inventoryLocationsTable = { __t: "inventory_locations", id: "id", tenantId: "tenantId", type: "type", csrBoxId: "csrBoxId" };
  const inventoryBalancesTable = { __t: "inventory_balances", id: "id", tenantId: "tenantId", productId: "productId", locationId: "locationId", quantityOnHand: "quantityOnHand" };
  const csrBoxesTable = { __t: "csr_boxes", id: "id", tenantId: "tenantId", slug: "slug" };
  const orderItems: Array<Record<string, unknown>> = [];

  function tableFor(t: { __t: string }): Array<Record<string, unknown>> {
    if (t.__t === "orders") return dbState.orders;
    if (t.__t === "users") return dbState.users;
    if (t.__t === "shifts") return dbState.shifts;
    if (t.__t === "admin_settings") return dbState.settings;
    if (t.__t === "tenants") return dbState.tenants;
    if (t.__t === "order_items") return orderItems;
    if (t.__t === "catalog") return dbState.catalog;
    if (t.__t === "inventory_locations") return dbState.inventoryLocations;
    if (t.__t === "inventory_balances") return dbState.inventoryBalances;
    if (t.__t === "csr_boxes") return dbState.csrBoxes;
    return [];
  }

  function matchesWhere(row: Record<string, unknown>, clause: unknown): boolean {
    if (!clause) return true;
    if (Array.isArray(clause)) return clause.every((part) => matchesWhere(row, part));
    if (typeof clause === "object" && clause && "and" in clause) {
      return ((clause as { and: unknown[] }).and).every((part) => matchesWhere(row, part));
    }
    if (typeof clause === "object" && clause && "col" in clause) {
      const { col, val } = clause as { col?: string; val?: unknown };
      return col ? row[col] === val : true;
    }
    return true;
  }

  const select = vi.fn((cols?: Record<string, unknown>) => {
    let pred: Pred = null;
    let target: { __t: string } | null = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: { __t: string }) => { target = t; return chain; });
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn((p: unknown) => {
      pred = (row) => matchesWhere(row, p);
      return chain;
    });
    const resolveRows = () => target ? tableFor(target).filter(r => pred ? pred(r) : true) : [];
    chain.orderBy = vi.fn(() => {
      // orderBy is chainable (e.g. .orderBy().limit()) but also awaitable
      const p = Promise.resolve(resolveRows()) as unknown as Record<string, unknown>;
      p.limit = vi.fn(() => Promise.resolve(resolveRows()));
      return p;
    });
    chain.limit = vi.fn(() => Promise.resolve(resolveRows()));
    chain.groupBy = vi.fn(() => Promise.resolve([]));
    void cols;
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
      resolve(target ? tableFor(target).filter(r => pred ? pred(r) : true) : []);
    return chain;
  });

  const insert = vi.fn((t: { __t: string }) => ({
    values: (vals: Record<string, unknown>) => ({
      returning: async () => {
        const now = new Date();
        const row = {
          id: tableFor(t).length + 100,
          createdAt: now, updatedAt: now,
          notes: "", paymentStatus: "unpaid",
          ...vals,
        };
        if (row.notes === null) row.notes = "";
        tableFor(t).push(row);
        return [row];
      },
    }),
  }));

  const update = vi.fn((t: { __t: string }) => {
    let setVals: Record<string, unknown> = {};
    let pred: Pred = null;
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((v: Record<string, unknown>) => { setVals = v; return chain; });
    chain.where = vi.fn((p: unknown) => {
      pred = (row) => matchesWhere(row, p);
      return chain;
    });
    const applyUpdate = async () => {
      const out: Array<Record<string, unknown>> = [];
      for (const row of tableFor(t)) {
        if (pred && pred(row)) {
          if (t.__t === "inventory_balances" && typeof setVals.quantityOnHand === "object" && setVals.quantityOnHand && "vals" in setVals.quantityOnHand) {
            const requested = Number((setVals.quantityOnHand as { vals: unknown[] }).vals[1]);
            const current = Number(row.quantityOnHand ?? 0);
            if (current < requested) continue;
            row.quantityOnHand = String(current - requested);
          } else {
            Object.assign(row, setVals);
          }
          out.push(row);
        }
      }
      return out;
    };
    chain.returning = vi.fn(applyUpdate);
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => unknown, reject?: (reason?: unknown) => unknown) =>
      applyUpdate().then(resolve, reject);
    return chain;
  });

  return {
    db: { execute: vi.fn(() => Promise.resolve()), select, insert, update, delete: vi.fn(), transaction: vi.fn(async (fn) => fn({ select, insert, update, delete: vi.fn() })) },
    ordersTable, usersTable, labTechShiftsTable, adminSettingsTable, tenantsTable, orderItemsTable, catalogItemsTable, inventoryLocationsTable, inventoryBalancesTable, csrBoxesTable,
    orderNotesTable: { __t: "order_notes" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...a) => ({ and: a })),
  asc: vi.fn((c) => c),
  desc: vi.fn((c) => c),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings: Array.from(strings), vals })), { raw: vi.fn() }),
}));

import ordersRouter from "../orders";
import {
  publishOrderEvent as _pub,
  subscribe,
  _resetBus,
  type OrderEvent,
} from "../../lib/orderEvents";
void _pub;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    };
    next();
  });
  app.use("/api", ordersRouter);
   
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("TEST ERR:", err.stack);
    res.status(500).json({ err: err.message, stack: err.stack });
  });
  return app;
}

function captureEvents(role: string, userId: number): { received: OrderEvent[]; teardown: () => void } {
  const received: OrderEvent[] = [];
  const fakeRes = {
    write: vi.fn((s: string) => {
      const m = s.match(/^data: (.+)\n\n$/);
      if (m) {
        try { received.push(JSON.parse(m[1]!) as OrderEvent); } catch { /* */ }
      }
      return true;
    }),
  } as unknown as import("express").Response;
  const teardown = subscribe({ res: fakeRes, userId, role });
  return { received, teardown };
}

beforeEach(() => {
  dbState.orders = [];
  dbState.users = [
    { id: 5, clerkId: "cust", email: "c@x.com", firstName: "Cust", lastName: "A", role: "user", status: "approved" },
    { id: 7, clerkId: "csr", email: "csr@x.com", firstName: "Cs", lastName: "R", role: "customer_service_rep", status: "approved" },
    { id: 9, clerkId: "admin", email: "admin@x.com", firstName: "Ad", lastName: "Min", role: "admin", status: "approved" },
  ];
  dbState.shifts = [];
  dbState.settings = [{
    id: 1, tenantId: 1, orderRoutingRule: "round_robin", defaultEtaMinutes: 30,
  }];
  dbState.tenants = [{ id: 1 }];
  dbState.catalog = [{ id: 1, name: "Test", price: "10.00", isAvailable: true, tenantId: 1, stockQuantity: "99", inventoryAmount: "99" }];
  dbState.inventoryLocations = [{ id: 1, tenantId: 1, type: "storefront", csrBoxId: null }];
  dbState.inventoryBalances = [{ id: 1, tenantId: 1, productId: 1, locationId: 1, quantityOnHand: "99" }];
  dbState.csrBoxes = [];
  mockActor = {};
  _resetBus();
});

describe("POST /api/orders — customer hourglass default 30 min", () => {
  it("stamps a 30-minute estimatedReadyAt and promisedMinutes=30 from defaults", async () => {
    mockActor = dbState.users[0]!; // customer
    const before = Date.now();
    const res = await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    expect([200, 201]).toContain(res.status);
    const inserted = dbState.orders[0]!;
    expect(inserted.promisedMinutes).toBe(30);
    const eta = new Date(inserted.estimatedReadyAt as Date).getTime();
    expect(eta).toBeGreaterThanOrEqual(before + 25 * 60_000);
    expect(eta).toBeLessThanOrEqual(before + 35 * 60_000 + 1000);
  });
});

describe("POST /api/orders — transactional inventory", () => {
  it("decrements inventory_balances and mirrors catalog stock in the order transaction", async () => {
    mockActor = dbState.users[0]!;
    const res = await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });

    expect([200, 201]).toContain(res.status);
    expect(dbState.inventoryBalances[0]!.quantityOnHand).toBe("98");
    expect(dbState.catalog[0]!.stockQuantity).toBe("98");
    expect(dbState.catalog[0]!.inventoryAmount).toBe("98");
  });

  it("returns 409 and rolls back order persistence when inventory is insufficient", async () => {
    mockActor = dbState.users[0]!;
    dbState.inventoryBalances[0]!.quantityOnHand = "0";

    const res = await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });

    expect(res.status).toBe(409);
    expect(dbState.orders).toHaveLength(0);
    expect(dbState.inventoryBalances[0]!.quantityOnHand).toBe("0");
  });

  it("rejects cross-tenant catalog products before decrementing inventory", async () => {
    mockActor = dbState.users[0]!;
    dbState.catalog[0]!.tenantId = 2;

    const res = await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });

    expect(res.status).toBe(403);
    expect(dbState.orders).toHaveLength(0);
    expect(dbState.inventoryBalances[0]!.quantityOnHand).toBe("99");
  });
});

describe("PATCH /api/orders/:id/eta — admin extends the hourglass", () => {
  it("updates promisedMinutes, recomputes estimatedReadyAt, and flags etaAdjustedBySupervisor", async () => {
    mockActor = dbState.users[0]!;
    await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    const orderId = dbState.orders[0]!.id as number;

    mockActor = dbState.users[2]!; // admin
    const before = Date.now();
    const res = await supertest(buildApp())
      .patch(`/api/orders/${orderId}/eta`)
      .send({ promisedMinutes: 75 });
    expect(res.status).toBe(200);
    const row = dbState.orders[0]!;
    expect(row.promisedMinutes).toBe(75);
    expect(row.etaAdjustedBySupervisor).toBe(true);
    const eta = new Date(row.estimatedReadyAt as Date).getTime();
    expect(eta).toBeGreaterThanOrEqual(before + 70 * 60_000);
    expect(eta).toBeLessThanOrEqual(before + 80 * 60_000 + 1000);
  });
});

describe("SSE event emission via the live route handlers", () => {
  it("POST /api/orders/:id/accept emits order.updated with reason='accepted' to admin subscribers", async () => {
    mockActor = dbState.users[0]!;
    await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    const orderId = dbState.orders[0]!.id as number;

    const adminCapture = captureEvents("admin", 999);
    mockActor = dbState.users[1]!; // CSR accepts
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/accept`)
      .send({});
    expect(res.status).toBe(200);
    adminCapture.teardown();
    const updated = adminCapture.received.find(e => e.type === "order.updated");
    expect(updated).toBeDefined();
    expect((updated as { reason: string }).reason).toBe("accepted");
    expect((updated as { fulfillmentStatus: string }).fulfillmentStatus).toBe("accepted");
  });

  it("POST /api/orders/:id/mark-ready emits an order.ready SSE event", async () => {
    mockActor = dbState.users[0]!;
    await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    const orderId = dbState.orders[0]!.id as number;

    const adminCapture = captureEvents("admin", 999);
    mockActor = dbState.users[2]!; // admin
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/mark-ready`)
      .send({});
    expect(res.status).toBe(200);
    adminCapture.teardown();
    const ready = adminCapture.received.find(e => e.type === "order.ready");
    expect(ready).toBeDefined();
    expect((ready as { orderId: number }).orderId).toBe(orderId);
  });

  it("POST /api/orders/:id/accept rejects orders not in submitted state with 409", async () => {
    mockActor = dbState.users[0]!;
    await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    const orderId = dbState.orders[0]!.id as number;
    dbState.orders[0]!.fulfillmentStatus = "preparing";
    mockActor = dbState.users[1]!;
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/accept`)
      .send({});
    expect(res.status).toBe(409);
  });

  it("POST /api/orders/:id/mark-ready is forbidden for CSRs", async () => {
    mockActor = dbState.users[0]!;
    await supertest(buildApp())
      .post("/api/orders")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], shippingAddress: "x", notes: "" });
    const orderId = dbState.orders[0]!.id as number;

    mockActor = dbState.users[1]!; // CSR
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/mark-ready`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("admin surfaces are not accessible to customer_service_rep", async () => {
    const sitter = { id: 7, role: "business_sitter", email: "s@x", firstName: "S", lastName: "Sitter" };
    dbState.users.push(sitter);
    mockActor = sitter;
    const app = buildApp();
    const delayed = await supertest(app).get("/api/orders/delayed");
    const csrs = await supertest(app).get("/api/orders/active-csrs");
    expect(delayed.status).toBe(403);
    expect(csrs.status).toBe(403);
  });
});
