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
} = { orders: [], users: [], shifts: [], settings: [], tenants: [], catalog: [], inventoryLocations: [], inventoryBalances: [], disclaimerAcceptances: [] };

let mockActor: Record<string, unknown> = {};

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "stub" })),
  clerkClient: { users: {} },
}));

function normalizeTestRole(role: string | undefined) {
  if (role === "global_admin") return "global_admin";
  if (role === "admin") return "admin";
  if (role === "supervisor") return "supervisor";
  if (
    role === "csr" ||
    role === "business_sitter" ||
    role === "sales_rep" ||
    role === "lab_tech" ||
    role === "lab_technician"
  ) return "csr";
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
const uberQuoteCalls: Array<{ manifestItems: unknown[] }> = [];
vi.mock("../../lib/uberDirect", () => {
  class UberDirectConfigError extends Error {}
  class UberDirectApiError extends Error { status = 422; }
  return {
    hasUberDirectConfig: () => true,
    getConfiguredPickupAddress: () => "123 Pickup St, Test City, CA",
    getUberPickupAction: () => "default",
    createUberDeliveryQuote: async (input: { manifestItems: unknown[] }) => {
      uberQuoteCalls.push({ manifestItems: input.manifestItems });
      return { id: "quote_safe_1", fee: 599, currency_type: "USD", pickup_action: "default" };
    },
    UberDirectConfigError,
    UberDirectApiError,
  };
});
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
    getCheckoutTaxSettings: async () => ({ taxRate: 0.08 }),
    normalizeCheckoutCart: async (items: Array<{ catalogItemId: number; quantity: number }> = [{ catalogItemId: 1, quantity: 1 }]) => (items.length ? items : [{ catalogItemId: 1, quantity: 1 }]).map((item) => ({
        catalog_item_id: item.catalogItemId,
        source_type: "local_mapped",
        merchant_brand: "alavont",
        catalog_display_name: "Alavont Internal",
        merchant_name: "Test LC",
        merchant_sku: `LC-${item.catalogItemId}`,
        display_name: "Safe Item",
        display_description: "Safe description",
        display_category: "Safe category",
        display_image: "safe.png",
        merchant_brand_name: "Safe Brand",
        marketing_copy: "Safe copy",
        customer_safe_name: "Safe Item",
        customer_safe_description: "Safe description",
        customer_safe_category: "Safe category",
        customer_safe_image: "safe.png",
        upsell_copy: null,
        promo_badges: [],
        receipt_alavont_name: "Alavont Internal",
        receipt_lucifer_name: "Test LC",
        merchant_image_url: null,
        unit_price: 10,
        quantity: item.quantity,
        line_subtotal: 10 * item.quantity,
        alavont_id: null,
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      })),
    computeCheckoutTotals: (lines: Array<{ line_subtotal: number }>) => {
      const subtotal = lines.reduce((s, l) => s + l.line_subtotal, 0);
      const tax = parseFloat((subtotal * 0.08).toFixed(2));
      return { subtotal, tax, total: subtotal + tax, taxRate: 0.08 };
    },
    getCheckoutTaxSettings: async () => ({ rate: 0.08 }),
    buildMerchantPayloadLines: () => [],
    buildReceiptLines: () => [],
  };
});
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/checkoutConversionGate", async () => {
  const actual = await vi.importActual<typeof import("../../lib/checkoutConversionGate")>("../../lib/checkoutConversionGate");
  return {
    ...actual,
    requireVerifiedCheckoutConversion: vi.fn(async (input: { checkoutConversionToken?: unknown; snapshot?: unknown }) => {
      if (!input.checkoutConversionToken || !input.snapshot) throw new actual.CheckoutConversionRequiredError();
      const lines = await import("../../lib/checkoutNormalizer").then((m) => m.normalizeCheckoutCart([]));
      const totals = await import("../../lib/checkoutNormalizer").then((m) => m.computeCheckoutTotals(lines));
      return { lines, totals, conversionExpiresAt: new Date(Date.now() + 15 * 60_000), snapshot: input.snapshot };
    }),
  };
});

vi.mock("@workspace/db", () => {
  type Pred = ((row: Record<string, unknown>) => boolean) | null;
  const ordersTable = { __t: "orders", id: "id", customerId: "customerId", assignedCsrUserId: "assignedCsrUserId", routedAt: "routedAt", acceptedAt: "acceptedAt", estimatedReadyAt: "estimatedReadyAt", status: "status" };
  const usersTable = { __t: "users", id: "id", role: "role", firstName: "firstName", lastName: "lastName", email: "email", contactPhone: "contactPhone", notificationPreferences: "notificationPreferences" };
  const labTechShiftsTable = { __t: "shifts", id: "id", techId: "techId", status: "status", clockedInAt: "clockedInAt" };
  const adminSettingsTable = { __t: "admin_settings", tenantId: "tenantId" };
  const customerDisclaimerAcceptancesTable = { __t: "customer_disclaimer_acceptances", tenantId: "tenantId", userId: "userId", disclaimerVersion: "disclaimerVersion" };
  const tenantsTable = { __t: "tenants", id: "id" };
  const orderItemsTable = { __t: "order_items", orderId: "orderId" };
  const catalogItemsTable = { __t: "catalog", id: "id", tenantId: "tenantId" };
  const inventoryLocationsTable = { __t: "inventory_locations", id: "id", tenantId: "tenantId", type: "type", csrBoxId: "csrBoxId" };
  const inventoryBalancesTable = { __t: "inventory_balances", id: "id", tenantId: "tenantId", productId: "productId", locationId: "locationId", quantityOnHand: "quantityOnHand", inventoryKind: "inventoryKind", isSellable: "isSellable", quarantinedAt: "quarantinedAt", quarantinedByUserId: "quarantinedByUserId", quarantineReason: "quarantineReason" };
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
    if (t.__t === "customer_disclaimer_acceptances") return dbState.disclaimerAcceptances;
    return [];
  }

  function matchesPredicate(row: Record<string, unknown>, predicate: unknown): boolean {
    if (!predicate) return true;
    if (Array.isArray(predicate)) return predicate.every((p) => matchesPredicate(row, p));
    const p = predicate as { col?: string; val?: unknown; vals?: unknown[] };
    if (p.vals) return p.vals.includes(row[p.col ?? ""]);
    if (p.col) return row[p.col] === p.val;
    return true;
  }

  const select = vi.fn((cols?: Record<string, unknown>) => {
    let pred: Pred = null;
    let target: { __t: string } | null = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: { __t: string }) => { target = t; return chain; });
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn((p: unknown) => {
      pred = (row) => matchesPredicate(row, p);
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
      pred = (row) => matchesPredicate(row, p);
      return chain;
    });
    chain.returning = vi.fn(async () => {
      const out: Array<Record<string, unknown>> = [];
      for (const row of tableFor(t)) {
        if (pred && pred(row)) {
          Object.assign(row, setVals);
          out.push(row);
        }
      }
      return out;
    });
    return chain;
  });

  return {
    db: { execute: vi.fn(() => Promise.resolve()), select, insert, update, delete: vi.fn(), transaction: vi.fn(async (fn) => fn({ select, insert, update, execute: vi.fn(() => Promise.resolve()) })) },
    ordersTable, usersTable, labTechShiftsTable, adminSettingsTable, tenantsTable, orderItemsTable, catalogItemsTable, inventoryLocationsTable, inventoryBalancesTable, csrBoxesTable, customerDisclaimerAcceptancesTable,
    orderNotesTable: { __t: "order_notes" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...a) => a),
  inArray: vi.fn((col, vals) => ({ col, vals })),
  asc: vi.fn((c) => c),
  desc: vi.fn((c) => c),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
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


const convertedItems = [{ catalogItemId: 1, quantity: 1 }];
const alavontShapedSkuRegressionItems = [{ catalogItemId: 440, quantity: 1 }];
const checkoutConfirmation = {
  acceptedAllSalesFinal: true,
  confirmedAt: "2026-06-24T00:00:00.000Z",
  legalDisclaimerText: "All sales are final.",
};

async function convertedCheckoutPayload(app = buildApp()) {
  const converted = await supertest(app)
    .post("/api/cart/convert")
    .send({ items: convertedItems, confirmation: checkoutConfirmation });
  expect(converted.status).toBe(200);
  const { conversionToken, ...checkoutConversionSnapshot } = converted.body as Record<string, unknown> & { conversionToken: string };
  return {
    items: convertedItems,
    checkoutConfirmation,
    checkoutConversionToken: conversionToken,
    checkoutConversionSnapshot,
  };
}

async function createConvertedOrder(app = buildApp()) {
  const payload = await convertedCheckoutPayload(app);
  const res = await supertest(app)
    .post("/api/orders")
    .send({ ...payload, shippingAddress: "x", notes: "" });
  expect([200, 201]).toContain(res.status);
  return dbState.orders[0]!;
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
    { id: 5, clerkId: "cust", email: "c@x.com", firstName: "Cust", lastName: "A", role: "user", status: "approved", tenantId: 1 },
    { id: 7, clerkId: "csr", email: "csr@x.com", firstName: "Cs", lastName: "R", role: "csr", status: "approved" },
    { id: 9, clerkId: "admin", email: "admin@x.com", firstName: "Ad", lastName: "Min", role: "admin", status: "approved" },
  ];
  dbState.shifts = [];
  dbState.settings = [{
    id: 1, tenantId: 1, orderRoutingRule: "round_robin", defaultEtaMinutes: 30, customerDisclaimerVersion: 1,
  }];
  dbState.tenants = [{ id: 1 }];
  dbState.catalog = [{ id: 1, name: "Alavont Internal", price: "10.00", isAvailable: true, tenantId: 1 }];
  dbState.inventoryLocations = [{ id: 50, tenantId: 1, type: "storefront", csrBoxId: null }];
  dbState.inventoryBalances = [{ id: 60, tenantId: 1, productId: 1, locationId: 50, quantityOnHand: 10, inventoryKind: "sellable_catalog", isSellable: true, quarantinedAt: null }];
  dbState.disclaimerAcceptances = [{ id: 70, tenantId: 1, userId: 5, disclaimerVersion: 1, acceptedAt: new Date() }];
  mockActor = {};
  uberQuoteCalls.length = 0;
  _resetBus();
});

describe("checkout conversion enforcement on order/provider API routes", () => {
  it("POST /api/cart/convert returns conversionToken and POST /api/orders accepts converted Cash checkout", async () => {
    mockActor = dbState.users[0]!;
    const app = buildApp();
    const converted = await supertest(app)
      .post("/api/cart/convert")
      .send({ items: convertedItems, confirmation: checkoutConfirmation });

    expect(converted.status).toBe(200);
    expect(converted.body.conversionToken).toEqual(expect.any(String));

    const { conversionToken, checkoutConversionToken, conversionExpiresAt, snapshotHash, ...checkoutConversionSnapshot } = converted.body as Record<string, unknown> & { conversionToken: string };
    const res = await supertest(app)
      .post("/api/orders")
      .send({
        items: convertedItems,
        shippingAddress: "x",
        notes: "",
        paymentMethod: "cash",
        selectedPaymentMethod: "cash",
        checkoutConversionToken: conversionToken,
        checkoutConversionSnapshot,
        checkoutConfirmation: { ...checkoutConfirmation, paymentMethod: "cash" },
      });

    expect([200, 201]).toContain(res.status);
    expect(dbState.orders).toHaveLength(1);
    expect(dbState.orders[0]).toEqual(expect.objectContaining({ paymentMethod: "cash" }));
    expect(checkoutConversionToken).toEqual(expect.any(String));
    expect(conversionExpiresAt).toEqual(expect.any(String));
    expect(snapshotHash).toEqual(expect.any(String));
  });


  it("POST /api/cart/convert accepts catalogItemId 440 and POST /api/orders creates Cash order with safe merchant SKU", async () => {
    mockActor = dbState.users[0]!;
    const app = buildApp();
    const converted = await supertest(app)
      .post("/api/cart/convert")
      .send({ items: alavontShapedSkuRegressionItems, confirmation: checkoutConfirmation });

    expect(converted.status).toBe(200);
    expect(converted.body.cartSnapshot[0].merchantSku).toBe("LC-440");
    expect(converted.body.cartSnapshot[0].merchantSku).not.toMatch(/ALV|ALAVONT/i);

    const { conversionToken, checkoutConversionToken, conversionExpiresAt, snapshotHash, ...checkoutConversionSnapshot } = converted.body as Record<string, unknown> & { conversionToken: string };
    const order = await supertest(app)
      .post("/api/orders")
      .send({
        items: alavontShapedSkuRegressionItems,
        shippingAddress: "x",
        notes: "",
        paymentMethod: "cash",
        selectedPaymentMethod: "cash",
        checkoutConversionToken: conversionToken,
        checkoutConversionSnapshot,
        checkoutConfirmation: { ...checkoutConfirmation, paymentMethod: "cash" },
      });

    expect([200, 201]).toContain(order.status);
    expect(dbState.orders).toHaveLength(1);
    expect(dbState.orders[0]).toEqual(expect.objectContaining({ paymentMethod: "cash" }));
    expect(checkoutConversionToken).toEqual(expect.any(String));
    expect(conversionExpiresAt).toEqual(expect.any(String));
    expect(snapshotHash).toEqual(expect.any(String));
  });

  it("POST /api/orders rejects unconverted carts with 422", async () => {
    mockActor = dbState.users[0]!;
    const res = await supertest(buildApp())
      .post("/api/orders")
      .send({
        items: [{ catalogItemId: 1, quantity: 1 }],
        checkoutConfirmation: { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final.", paymentMethod: "cash" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/converted/i);
  });

  it("POST /api/orders/delivery-quote rejects unconverted provider payloads with 422", async () => {
    mockActor = dbState.users[0]!;
    const res = await supertest(buildApp())
      .post("/api/orders/delivery-quote")
      .send({ items: [{ catalogItemId: 1, quantity: 1 }], dropoffAddress: "456 Dropoff St, Test City, CA" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/converted/i);
    expect(uberQuoteCalls).toHaveLength(0);
  });

  it("POST /api/orders/delivery-quote accepts converted carts and sends Safe provider payload fields only", async () => {
    mockActor = dbState.users[0]!;
    const items = [{ catalogItemId: 1, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true as const, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final." };
    const preview = await supertest(buildApp()).post("/api/orders/preview-conversion").send({ items, confirmation });
    expect(preview.status).toBe(200);

    const res = await supertest(buildApp())
      .post("/api/orders/delivery-quote")
      .send({
        items,
        dropoffAddress: "456 Dropoff St, Test City, CA",
        checkoutConversionToken: preview.body.checkoutConversionToken,
        checkoutConversionSnapshot: preview.body,
        checkoutConfirmation: confirmation,
      });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("uber_direct");
    expect(uberQuoteCalls).toHaveLength(1);
    expect(uberQuoteCalls[0].manifestItems).toEqual([expect.objectContaining({ name: "Safe Item", special_instructions: "Safe category", quantity: 1, price: 1000 })]);
    const payloadText = JSON.stringify(uberQuoteCalls[0].manifestItems);
    expect(payloadText).not.toContain("Test LC");
    expect(payloadText).not.toContain("LC-TEST");
  });
});

describe("POST /api/orders — customer hourglass default 30 min", () => {
  it("stamps a 30-minute estimatedReadyAt and promisedMinutes=30 from defaults", async () => {
    mockActor = dbState.users[0]!; // customer
    const before = Date.now();
    const app = buildApp();
    const payload = await convertedCheckoutPayload(app);
    const res = await supertest(app)
      .post("/api/orders")
      .send({ ...payload, shippingAddress: "x", notes: "" });
    expect([200, 201]).toContain(res.status);
    const inserted = dbState.orders[0]!;
    expect(inserted.promisedMinutes).toBe(30);
    const eta = new Date(inserted.estimatedReadyAt as Date).getTime();
    expect(eta).toBeGreaterThanOrEqual(before + 25 * 60_000);
    expect(eta).toBeLessThanOrEqual(before + 35 * 60_000 + 1000);
  });
});

describe("PATCH /api/orders/:id/eta — admin extends the hourglass", () => {
  it("updates promisedMinutes, recomputes estimatedReadyAt, and flags etaAdjustedBySupervisor", async () => {
    mockActor = dbState.users[0]!;
    const orderId = (await createConvertedOrder()).id as number;

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
    const orderId = (await createConvertedOrder()).id as number;

    const adminCapture = captureEvents("admin", 999);
    dbState.shifts = [{ id: 77, tenantId: 1, techId: 7, status: "active", clockedInAt: new Date(), boxAssignmentId: "sales-box-1", setupJson: { inventoryConfirmed: true, parLevelsConfirmed: true, printerAssigned: true } }];
    mockActor = dbState.users[1]!; // CSR accepts
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/accept`)
      .send({});
    expect(res.status).toBe(200);
    adminCapture.teardown();
    const updated = adminCapture.received.find(e => e.type === "order.updated");
    expect(updated).toBeDefined();
    expect((updated as { reason: string }).reason).toBe("accepted");
    expect((updated as { fulfillmentStatus: string }).fulfillmentStatus).toBe("in_progress");
  });

  it("POST /api/orders/:id/mark-ready emits an order.ready SSE event", async () => {
    mockActor = dbState.users[0]!;
    const orderId = (await createConvertedOrder()).id as number;

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
    const orderId = (await createConvertedOrder()).id as number;
    dbState.orders[0]!.fulfillmentStatus = "preparing";
    dbState.shifts = [{ id: 77, tenantId: 1, techId: 7, status: "active", clockedInAt: new Date(), boxAssignmentId: "sales-box-1", setupJson: { inventoryConfirmed: true, parLevelsConfirmed: true, printerAssigned: true } }];
    mockActor = dbState.users[1]!;
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/accept`)
      .send({});
    expect(res.status).toBe(409);
  });

  it("POST /api/orders/:id/mark-ready is forbidden for CSRs", async () => {
    mockActor = dbState.users[0]!;
    const orderId = (await createConvertedOrder()).id as number;

    mockActor = dbState.users[1]!; // CSR
    const res = await supertest(buildApp())
      .post(`/api/orders/${orderId}/mark-ready`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("admin surfaces are not accessible to csr", async () => {
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
