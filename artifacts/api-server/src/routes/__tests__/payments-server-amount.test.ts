// Task #13: /payments/tokenize must ignore client-supplied `amount` and
// charge the server-trusted total derived from the normalized order lines.
// A client cannot underpay by sending a smaller amount.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const dbState: {
  orders: Array<Record<string, unknown>>;
  orderItems: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
} = { orders: [], orderItems: [], users: [], audits: [] };

const mockActor: Record<string, unknown> = { id: 1, email: "u@example.com", role: "user" };

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "stub" })),
  clerkClient: { users: {} },
}));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { dbUser: Record<string, unknown> }).dbUser = mockActor;
    next();
  },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeAuditLog: vi.fn(async (entry: Record<string, unknown>) => { dbState.audits.push(entry); }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Critical: this mock returns a fixed normalized line whose server-recomputed
// total is exactly $43.20 (= 2 × $20 + 8% tax). The test below sends a
// client-supplied amount of $0.01 and proves the Stripe path uses $43.20.
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
    CartLineInput: z.object({ catalogItemId: z.number().int().positive(), quantity: z.number().int().positive() }).strict(),
    CHECKOUT_TAX_RATE: 0.08,
    normalizeCheckoutCart: async () => ([
      {
        catalog_item_id: 50,
        source_type: "local_mapped",
        merchant_brand: "alavont",
        catalog_display_name: "Alavont Tee",
        merchant_name: "LC Tee",
        merchant_sku: "LC-TEE-1",
        receipt_alavont_name: "Alavont Tee",
        receipt_lucifer_name: "LC Tee",
        merchant_image_url: null,
        unit_price: 20,
        quantity: 2,
        line_subtotal: 40,
        alavont_id: "ALV-50",
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      },
    ]),
    computeCheckoutTotals: () => ({ subtotal: 40, tax: 3.2, total: 43.2, taxRate: 0.08 }),
    buildMerchantPayloadLines: () => [],
    buildReceiptLines: () => [],
  };
});

// Capture the args passed to buildStripeIntentPayload so the test can assert
// that the server amount — not the client amount — was forwarded to Stripe.
const stripePayloadCalls: Array<{ amount: number; lines: unknown[] }> = [];
vi.mock("../../lib/stripePayload", () => ({
  LUCIFER_CRUZ_STATEMENT_SUFFIX: "LCRUZ ORDER",
  buildStripeIntentPayload: (input: { orderId: number; amount: number; currency: string; lines: unknown[] }) => {
    stripePayloadCalls.push({ amount: input.amount, lines: input.lines });
    return {
      amount: Math.round(input.amount * 100),
      currency: input.currency,
      description: `Order #${input.orderId}`,
      metadata: { orderId: String(input.orderId), merchantBrand: "lucifer_cruz" },
      statement_descriptor_suffix: "LCRUZ ORDER",
    };
  },
  payloadContainsAlavontLeak: () => ({ leaked: false, offenders: [] }),
}));

vi.mock("@workspace/db", () => {
  type Pred = ((row: Record<string, unknown>) => boolean) | null;
  const ordersTable = { __t: "orders", id: "id" };
  const orderItemsTable = { __t: "order_items", orderId: "orderId" };

  function tableFor(t: { __t: string }): Array<Record<string, unknown>> {
    if (t.__t === "orders") return dbState.orders;
    if (t.__t === "order_items") return dbState.orderItems;
    return [];
  }

  const select = vi.fn(() => {
    let pred: Pred = null;
    let target: { __t: string } | null = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((t: { __t: string }) => { target = t; return chain; });
    chain.where = vi.fn((p: { col?: string; val?: unknown }) => {
      pred = (row) => row[p.col ?? ""] === p.val;
      return chain;
    });
    const resolveRows = () => target ? tableFor(target).filter(r => pred ? pred(r) : true) : [];
    chain.limit = vi.fn(() => Promise.resolve(resolveRows()));
    // also awaitable directly
    return Object.assign(chain, { then: (onF: (rows: unknown[]) => unknown) => onF(resolveRows()) });
  });

  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  }));

  return {
    db: { select, update },
    ordersTable,
    orderItemsTable,
  };
});

import paymentsRouter from "../payments";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", paymentsRouter);
  return app;
}

beforeEach(() => {
  dbState.orders = [];
  dbState.orderItems = [];
  dbState.audits = [];
  stripePayloadCalls.length = 0;
  delete process.env.STRIPE_SECRET_KEY;
});

describe("Task #13 — /payments/tokenize ignores client amount", () => {
  it("uses server-derived amount even when client tries to send $0.01", async () => {
    dbState.orders.push({
      id: 555,
      customerId: 1,
      status: "pending",
      paymentStatus: "unpaid",
      total: "43.20",
      subtotal: "40.00",
      tax: "3.20",
    });
    dbState.orderItems.push({ orderId: 555, catalogItemId: 50, quantity: 2 });

    const res = await supertest(makeApp())
      .post("/api/payments/tokenize")
      .send({ orderId: 555, amount: 0.01 });

    expect(res.status).toBe(200);
    expect(stripePayloadCalls).toHaveLength(1);
    // Server-trusted total (43.20) — NOT the $0.01 the client tried to send.
    expect(stripePayloadCalls[0].amount).toBeCloseTo(43.2, 2);
  });

  it("falls back to order.total when an order has no line items", async () => {
    dbState.orders.push({
      id: 556,
      customerId: 1,
      status: "pending",
      paymentStatus: "unpaid",
      total: "100.00",
    });
    // No order_items rows.

    const res = await supertest(makeApp())
      .post("/api/payments/tokenize")
      .send({ orderId: 556, amount: 9999 });

    expect(res.status).toBe(200);
    expect(stripePayloadCalls).toHaveLength(1);
    expect(stripePayloadCalls[0].amount).toBeCloseTo(100, 2);
  });
});
