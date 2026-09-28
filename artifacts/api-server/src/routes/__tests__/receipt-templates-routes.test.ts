/**
 * Receipt Phase 1 routes: tenant isolation for receipt templates, template
 * management authorisation, synthetic preview, and reprint through the shared
 * receipt pipeline. The db is an in-memory fake that evaluates the routes'
 * drizzle predicates, so tenant filters are exercised rather than asserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = Record<string, unknown>;
type Col = { table: string; col: string };
type Pred = { op: "eq"; c: Col; v: unknown } | { op: "and" | "or"; p: Pred[] } | { op: "true" };

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  reads: [] as string[],
  nextId: 1,
  user: { id: 100, role: "admin", status: "approved", tenantId: 1, email: "admin@t1" } as Record<string, unknown>,
}));

vi.mock("drizzle-orm", () => ({
  eq: (c: unknown, v: unknown) => ({ op: "eq", c, v }),
  and: (...p: unknown[]) => ({ op: "and", p: p.filter(Boolean) }),
  or: (...p: unknown[]) => ({ op: "or", p: p.filter(Boolean) }),
  inArray: () => ({ op: "true" }),
  desc: (c: unknown) => c,
  sql: () => ({ op: "true" }),
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) =>
    new Proxy({ __name: name } as Record<string, unknown>, {
      get: (target, prop: string) => (prop === "__name" ? target.__name : { table: name, col: prop }),
    });
  const rows = (t: Record<string, unknown>) => (store.tables[t.__name as string] ??= []);
  const matches = (row: Row, p?: Pred): boolean => {
    if (!p) return true;
    if (p.op === "eq") return row[p.c.col] === p.v;
    if (p.op === "and") return p.p.every((x) => matches(row, x));
    if (p.op === "or") return p.p.some((x) => matches(row, x));
    return true;
  };
  const project = (row: Row, fields?: Record<string, Col>) =>
    fields ? Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, row[c.col]])) : { ...row };
  const db = {
    select: (fields?: Record<string, Col>) => ({
      from: (t: Record<string, unknown>) => {
        store.reads.push(t.__name as string);
        let pred: Pred | undefined;
        let max = Infinity;
        const run = () => rows(t).filter((r) => matches(r, pred)).slice(0, max).map((r) => project(r, fields));
        const chain = {
          where: (p: Pred) => ((pred = p), chain),
          orderBy: () => chain,
          innerJoin: () => chain,
          limit: (n: number) => ((max = n), chain),
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
        };
        return chain;
      },
    }),
    insert: (t: Record<string, unknown>) => ({
      values: (v: Row) => {
        const row = { id: store.nextId++, ...v };
        rows(t).push(row);
        const done = Promise.resolve([row]);
        return { returning: () => done, then: done.then.bind(done) };
      },
    }),
    update: (t: Record<string, unknown>) => ({
      set: (u: Row) => ({
        where: (p: Pred) => {
          const hit = rows(t).filter((r) => matches(r, p));
          hit.forEach((r) => Object.assign(r, u));
          const done = Promise.resolve(hit);
          return { returning: () => done, then: done.then.bind(done) };
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve([]) }),
  };
  const names = [
    "printPrintersTable", "printBridgeProfilesTable", "printJobsTable", "printJobAttemptsTable",
    "printSettingsTable", "operatorPrintProfilesTable", "printTemplatesTable", "printAssetsTable",
    "usersTable", "ordersTable", "orderItemsTable", "adminSettingsTable", "auditLogsTable",
    "printTemplateVersionsTable", "inventoryLocationsTable", "shiftPrintAssignmentsTable", "printRoutesTable",
    "paymentAttemptsTable", "paymentCapturesTable", "catalogItemsTable",
  ];
  return { db, ...Object.fromEntries(names.map((n) => [n, table(n)])) };
});

vi.mock("../../lib/auth", () => ({
  requireAuth: (_q: unknown, _s: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _s: unknown, next: () => void) => {
    req.dbUser = { ...store.user };
    next();
  },
  requireDbUser: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireApproved: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: { dbUser: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      roles.includes(req.dbUser.role) ? next() : res.status(403).json({ error: "Forbidden: insufficient role" }),
}));

const dispatchReceiptJob = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/printService", () => ({
  dispatchJob: vi.fn(),
  dispatchReceiptJob,
  dispatchLabelJob: vi.fn(),
  makeIdempotencyKey: (orderId: number, printerId: number, kind: string) => `order:${orderId}:${printerId}:${kind}`,
  getSettings: async () => ({
    id: 1, paperWidth: "80mm", brandName: null, footerMessage: "Legacy footer", receiptTemplateStyle: "clean",
    includeOperatorName: true, showDiscreetNotice: false, autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false,
  }),
}));
const RECEIPT_PRINTER = { id: 1, tenantId: 1, name: "Brightek POS80", role: "receipt", routingScope: "general", locationId: null, isActive: true };
vi.mock("../../lib/printRouter", () => ({
  selectActiveOperator: vi.fn(async () => null),
  probePrinter: vi.fn(),
  resolveReceiptPrinters: vi.fn(async () => ({ primary: RECEIPT_PRINTER, fallback: null })),
  resolveLabelPrinter: vi.fn(),
  resolveBridgeApiKey: (key: string | null) => key || "central-key",
}));
vi.mock("../../config/tenantConfig", () => ({
  getTenantSettings: async (tenantId: number) => ({
    business: {
      publicBusinessName: tenantId === 1 ? "Tenant One Shop" : "Tenant Two Shop",
      supportPhone: "(916) 555-0100",
      businessAddress: { line1: "1 Main St", city: "Sacramento", region: "CA", postalCode: "95814" },
      timezone: "America/Los_Angeles",
    },
  }),
}));
vi.mock("../../config/brandingConfig", () => ({ getBranding: async () => ({ supplier: { displayName: "Lucifer Cruz" } }) }));
vi.mock("../../lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock("../../lib/escposPrinter", () => ({ printReceiptEscPos: vi.fn() }));
vi.mock("sharp", () => ({ default: vi.fn() }));

const { default: printRouter } = await import("../print");
const { renderOrderReceipt, loadReceiptData } = await import("../../lib/print/receiptPipeline");
const { PREVIEW_BANNER } = await import("../../lib/print/receiptPipeline");
const app = express();
app.use(express.json());
app.use("/api", printRouter);
const api = supertest(app);

const asUser = (tenantId: number, role = "admin") => {
  store.user = { id: tenantId * 100, role, status: "approved", tenantId, email: `u@t${tenantId}` };
};

const TEMPLATE = [
  { type: "data", id: "biz", field: "businessName", align: "center", bold: true },
  { type: "data", id: "num", field: "orderNumber" },
  { type: "data", id: "items", field: "items" },
  { type: "data", id: "tot", field: "total", bold: true },
];

function seedTemplate(tenantId: number, text: string, extra: Row = {}) {
  const row = {
    id: store.nextId++, tenantId, name: `T${tenantId}`, jobType: "receipt", version: 1, schemaVersion: 1,
    paperWidth: "80mm", paperHeight: "auto", isActive: true, isDefault: true, updatedAt: new Date(),
    templateJson: [{ type: "customText", id: "who", text }, ...TEMPLATE], ...extra,
  };
  (store.tables.printTemplatesTable ??= []).push(row);
  return row;
}

function seedOrder(tenantId: number) {
  const order = {
    id: store.nextId++, tenantId, customerId: 900, assignedCsrUserId: 901, assignedShiftId: null, createdAt: new Date("2026-09-28T10:05:00Z"),
    orderType: "pickup", notes: null, paymentStatus: "paid", paymentMethod: "cash",
    subtotal: "52.00", grossSubtotal: "52.00", discountTotal: "2.00", taxableSubtotal: "50.00", tax: "4.00", total: "54.00",
    customerCreditApplied: "0.00", remainingTenderAmount: "54.00", amountTendered: "60.00", changeGiven: "6.00",
    taxSnapshot: { taxRate: 0.08, jurisdiction: "Sacramento, California" }, paymentToken: "tok_secret_do_not_print",
  };
  (store.tables.ordersTable ??= []).push(order);
  (store.tables.orderItemsTable ??= []).push(
    { id: store.nextId++, orderId: order.id, catalogItemId: 55, catalogItemName: "Catalog Name", receiptName: "Snapshot Product", alavontName: null, luciferCruzName: null, quantity: 2, unitPrice: "26.00", totalPrice: "52.00" },
  );
  // The live catalogue has since changed; receipts must not read it.
  (store.tables.catalogItemsTable ??= []).push({ id: 55, tenantId, name: "Renamed In Catalogue", price: "99.00" });
  return order;
}

beforeEach(() => {
  store.tables = {
    usersTable: [
      { id: 900, firstName: "Casey", lastName: "Jones" },
      { id: 901, firstName: "Luke", lastName: "S" },
    ],
  };
  store.reads = [];
  store.nextId = 1000;
  dispatchReceiptJob.mockClear();
  asUser(1);
});

describe("receipt template tenant isolation", () => {
  it("never lists another tenant's templates", async () => {
    seedTemplate(2, "TENANT B");
    const res = await api.get("/api/print/templates");
    expect(res.body.templates).toEqual([]);
  });

  it("refuses to modify another tenant's template", async () => {
    const other = seedTemplate(2, "TENANT B");
    const res = await api.patch(`/api/print/templates/${other.id}`).send({ templateJson: [{ type: "customText", id: "x", text: "HIJACKED" }] });
    expect(res.status).toBe(404);
    expect(JSON.stringify(other.templateJson)).toContain("TENANT B");
    expect(other.version).toBe(1);
  });

  it("cannot deactivate another tenant's template", async () => {
    const other = seedTemplate(2, "TENANT B");
    await api.delete(`/api/print/templates/${other.id}`);
    expect(other.isActive).toBe(true);
  });

  it("never renders another tenant's default template", async () => {
    seedTemplate(2, "TENANT B");
    const order = seedOrder(1);
    const rendered = await renderOrderReceipt(1, order.id);
    expect(rendered?.receipt.source).toBe("fallback");
    expect(rendered?.receipt.text).not.toContain("TENANT B");
    const preview = await api.post("/api/print/preview/receipt").send({});
    expect(preview.headers["x-receipt-source"]).toBe("fallback");
    expect(preview.text).not.toContain("TENANT B");
  });

  it("refuses to preview another tenant's template by id", async () => {
    const other = seedTemplate(2, "TENANT B");
    const res = await api.post("/api/print/preview/receipt").send({ templateId: other.id });
    expect(res.status).toBe(404);
  });

  it("uses the caller's own default template", async () => {
    seedTemplate(2, "TENANT B");
    seedTemplate(1, "TENANT A");
    const order = seedOrder(1);
    const rendered = await renderOrderReceipt(1, order.id);
    expect(rendered?.receipt.source).toBe("template");
    expect(rendered?.receipt.text).toContain("TENANT A");
    expect(rendered?.receipt.text).not.toContain("TENANT B");
  });
});

describe("template management authorisation", () => {
  it.each(["csr", "supervisor", "customer"])("rejects %s for every template and preview route", async (role) => {
    const mine = seedTemplate(1, "TENANT A");
    asUser(1, role);
    const results = await Promise.all([
      api.get("/api/print/templates"),
      api.post("/api/print/templates").send({ name: "x", jobType: "receipt", templateJson: TEMPLATE }),
      api.patch(`/api/print/templates/${mine.id}`).send({ name: "renamed" }),
      api.delete(`/api/print/templates/${mine.id}`),
      api.post("/api/print/preview/receipt").send({}),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(mine).toMatchObject({ name: "T1", isActive: true });
  });

  it("rejects templates with printer commands or unknown fields on save", async () => {
    for (const templateJson of [
      [{ type: "customText", id: "t", text: "\x1b@\x1dVA" }],
      [{ type: "data", id: "t", field: "total", value: 0 }],
      [{ type: "data", id: "t", field: "creditCardNumber" }],
    ]) {
      const res = await api.post("/api/print/templates").send({ name: "bad", jobType: "receipt", templateJson });
      expect(res.status).toBe(400);
    }
    expect(store.tables.printTemplatesTable ?? []).toHaveLength(0);
  });
});

describe("receipt preview", () => {
  it("renders fixed synthetic data, clearly marked, without reading any order", async () => {
    seedOrder(1);
    store.reads = [];
    const res = await api.post("/api/print/preview/receipt").send({ templateJson: TEMPLATE, paperWidth: "58mm" });
    expect(res.status).toBe(200);
    expect(res.text.startsWith(PREVIEW_BANNER)).toBe(true);
    expect(res.text).toContain("SAMPLE BUSINESS");
    expect(res.text).toContain("Order #SAMPLE-0001");
    expect(res.text).not.toContain("Snapshot Product");
    expect(store.reads).not.toContain("ordersTable");
    expect(store.reads).not.toContain("orderItemsTable");
    expect(res.headers["x-receipt-source"]).toBe("template");
  });

  it("refuses client-supplied order data and invalid drafts", async () => {
    for (const body of [{ orderId: 1 }, { items: [{ name: "x", total: 0 }] }, { total: 0 }]) {
      expect((await api.post("/api/print/preview/receipt").send(body)).status).toBe(400);
    }
    const bad = await api.post("/api/print/preview/receipt").send({ templateJson: [{ type: "customText", id: "t", text: "\x1b@" }] });
    expect(bad.status).toBe(400);
  });

  it("reports unsupported logo/QR blocks instead of pretending to render them", async () => {
    const res = await api.post("/api/print/preview/receipt").send({
      templateJson: [{ type: "data", id: "logo", field: "logo" }, { type: "data", id: "qr", field: "qrCode" }, ...TEMPLATE],
    });
    expect(res.headers["x-receipt-skipped"]).toBe("logo:unsupported,qrCode:unsupported");
  });

  it("does not create print jobs or dispatch anything", async () => {
    await api.post("/api/print/preview/receipt").send({ templateJson: TEMPLATE });
    expect(store.tables.printJobsTable ?? []).toHaveLength(0);
    expect(dispatchReceiptJob).not.toHaveBeenCalled();
  });
});

describe("reprint uses the shared receipt data builder", () => {
  it("stores exactly the shared pipeline's receipt text", async () => {
    seedTemplate(1, "TENANT A");
    const order = seedOrder(1);
    const res = await api.post(`/api/print/orders/${order.id}/receipt`).send({});
    expect(res.status).toBe(200);
    const [job] = store.tables.printJobsTable!;
    const expected = await renderOrderReceipt(1, order.id);
    expect(job!.renderedText).toBe(expected!.receipt.text);
    expect(job).toMatchObject({ tenantId: 1, orderId: order.id, printerId: 1, templateId: expected!.receipt.templateId });
    expect(JSON.stringify(job!.payloadJson)).not.toMatch(/Casey|Jones|tok_/);
    expect(dispatchReceiptJob).toHaveBeenCalledTimes(1);
  });

  it("refuses another tenant's order", async () => {
    const order = seedOrder(2);
    const res = await api.post(`/api/print/orders/${order.id}/receipt`).send({});
    expect(res.status).toBe(404);
    expect(store.tables.printJobsTable ?? []).toHaveLength(0);
  });

  it("builds receipt data from the order's historical snapshot, not the live catalogue", async () => {
    const order = seedOrder(1);
    store.reads = [];
    const data = await loadReceiptData(1, order.id);
    expect(data?.items[0]).toMatchObject({ displayName: "Snapshot Product", quantity: 2, unitPriceCents: 2600, lineTotalCents: 5200 });
    expect(data?.totals).toMatchObject({ subtotalCents: 5200, discountCents: 200, taxCents: 400, totalCents: 5400 });
    expect(data?.payment).toMatchObject({ tenderLabel: "Cash", cashReceivedCents: 6000, changeCents: 600 });
    expect(data?.business.name).toBe("Tenant One Shop");
    expect(store.reads).not.toContain("catalogItemsTable");
    expect(JSON.stringify(data)).not.toMatch(/tok_secret|Renamed In Catalogue/);
    expect(await loadReceiptData(2, order.id)).toBeNull();
  });
});

describe("automatic and reprint receipts share one path (source contract)", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const printService = readFileSync(resolve(root, "src/lib/printService.ts"), "utf8");
  const printRoutes = readFileSync(resolve(root, "src/routes/print.ts"), "utf8");

  it("renders automatic receipts through renderOrderReceipt", () => {
    const helper = printService.slice(printService.indexOf("async function renderAutomaticReceipt"), printService.indexOf("export async function enqueueOrderPrintJobs"));
    expect(helper).toContain("renderOrderReceipt(tenantId, orderId)");
    const receiptBranch = printService.slice(printService.indexOf("// ── Receipt ──"), printService.indexOf("// ── Kitchen ticket"));
    expect(receiptBranch).toContain("await renderAutomaticReceipt(tenantId, order.id, printOrder)");
    expect(receiptBranch).not.toContain("renderCustomerReceipt(printOrder)");
  });

  it("renders reprints through renderOrderReceipt and previews through renderReceiptPreview", () => {
    const reprint = printRoutes.slice(printRoutes.indexOf('router.post("/print/orders/:id/receipt"'), printRoutes.indexOf('router.post("/print/orders/:id/label"'));
    expect(reprint).toContain("renderOrderReceipt(tenantId, orderId)");
    expect(reprint).not.toContain("renderCustomerReceipt");
    const preview = printRoutes.slice(printRoutes.indexOf('"/print/preview/receipt",'), printRoutes.indexOf('"/print/preview/inventory-start",'));
    expect(preview).toContain("renderReceiptPreview(");
    expect(preview).toContain("SAMPLE_RECEIPT_DATA");
    expect(preview).not.toContain("printReceiptEscPos");
  });
});
