/**
 * Printing system: deterministic document routing, printer classes, job
 * rendering, the printing admin API, test prints, previews, and the
 * restock-slip tenant boundary (BOLA) repair.
 *
 * The db is an in-memory fake that evaluates the code's drizzle predicates,
 * so tenant, location and class checks are exercised rather than asserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Row = Record<string, unknown>;
type Col = { table: string; col: string };
type Pred = { op: "eq"; c: Col; v: unknown } | { op: "isnull"; c: Col } | { op: "and" | "or"; p: Pred[] } | { op: "true" };

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  nextId: 1,
  user: {} as Record<string, unknown>,
  legacyPrinter: null as Record<string, unknown> | null,
  /** print_jobs.job_type values production's check constraint admits. */
  allowedJobTypes: null as Set<string> | null,
}));

vi.mock("drizzle-orm", () => {
  const ops: Record<string, unknown> = {
    eq: (c: unknown, v: unknown) => ({ op: "eq", c, v }),
    isNull: (c: unknown) => ({ op: "isnull", c }),
    and: (...p: unknown[]) => ({ op: "and", p: p.filter(Boolean) }),
    or: (...p: unknown[]) => ({ op: "or", p: p.filter(Boolean) }),
    desc: (c: unknown) => c,
    asc: (c: unknown) => c,
  };
  const sql = Object.assign(() => ({ op: "true" }), { raw: () => ({ op: "true" }) });
  return new Proxy({ ...ops, sql } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : key === "then" ? undefined : () => ({ op: "true" })),
    has: () => true,
  });
});

vi.mock("@workspace/db", () => {
  const table = (name: string) =>
    new Proxy({ __name: name } as Record<string, unknown>, {
      get: (target, prop: string) => (prop === "__name" ? target.__name : { table: name, col: prop }),
    });
  const rows = (t: Record<string, unknown>) => (store.tables[t.__name as string] ??= []);
  const matches = (row: Row, p?: Pred): boolean => {
    if (!p) return true;
    if (p.op === "eq") return row[p.c.col] === p.v;
    if (p.op === "isnull") return row[p.c.col] === null || row[p.c.col] === undefined;
    if (p.op === "and") return p.p.every((x) => matches(row, x));
    if (p.op === "or") return p.p.some((x) => matches(row, x));
    return true;
  };
  const project = (row: Row, fields?: Record<string, Col>) =>
    fields ? Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, row[c.col]])) : { ...row };
  const db: Record<string, unknown> = {
    select: (fields?: Record<string, Col>) => ({
      from: (t: Record<string, unknown>) => {
        let pred: Pred | undefined;
        let max = Infinity;
        const run = () => rows(t).filter((r) => matches(r, pred)).slice(0, max).map((r) => project(r, fields));
        const chain: Record<string, unknown> = {
          where: (p: Pred) => ((pred = p), chain),
          orderBy: () => chain,
          innerJoin: () => chain,
          limit: (n: number) => ((max = n), chain),
          for: () => chain,
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
        };
        return chain;
      },
    }),
    insert: (t: Record<string, unknown>) => ({
      values: (v: Row) => {
        const make = () => {
          // Production's print_jobs_job_type_check (job_type is generated from job_output).
          const jobType = String(v.jobType ?? "order_ticket");
          if (t.__name === "printJobsTable" && store.allowedJobTypes && !store.allowedJobTypes.has(jobType)) {
            throw new Error(`new row for relation "print_jobs" violates check constraint "print_jobs_job_type_check" (${jobType})`);
          }
          const row = { id: store.nextId++, ...v }; rows(t).push(row); return row;
        };
        return {
          returning: () => Promise.resolve().then(() => [make()]),
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(() => [make()]).then(ok, bad),
        };
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
    execute: () => Promise.resolve({ rows: [] }),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  // Every table name resolves; `has` lets vitest see each named export.
  return new Proxy({ db } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : key === "then" ? undefined : table(key)),
    has: () => true,
  });
});

vi.mock("../../lib/auth", () => ({
  requireAuth: (_q: unknown, _s: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _s: unknown, next: () => void) => { req.dbUser = { ...store.user }; next(); },
  requireDbUser: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireApproved: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: { dbUser: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      roles.includes(req.dbUser.role) ? next() : res.status(403).json({ error: "Forbidden: insufficient role" }),
  writeAuditLog: async (entry: Row) => { (store.tables.auditLogsTable ??= []).push({ ...entry, via: "writeAuditLog" }); },
  normalizeRole: (role: string) => role,
}));
const dispatchJob = vi.hoisted(() => vi.fn(async (job: { id: number }) => {
  const row = store.tables.printJobsTable?.find((r) => r.id === job.id);
  if (row) row.status = "printed";
}));
vi.mock("../../lib/printService", () => ({
  dispatchJob, dispatchReceiptJob: dispatchJob, dispatchLabelJob: vi.fn(), makeIdempotencyKey: vi.fn(),
  getSettings: async () => ({ id: 1, paperWidth: "80mm", footerMessage: null, brandName: null, receiptTemplateStyle: "clean", includeOperatorName: true, showDiscreetNotice: false }),
}));
vi.mock("../../lib/printRouter", () => ({
  selectActiveOperator: vi.fn(async () => null), probePrinter: vi.fn(), resolveLabelPrinter: vi.fn(), getOperatorProfile: vi.fn(async () => null),
  resolveReceiptPrinters: vi.fn(async () => ({ primary: store.legacyPrinter, fallback: null })),
  resolveExpoPrinter: vi.fn(async () => null),
  resolveBridgeApiKey: (key: string | null) => key || "central-key",
}));
vi.mock("../../config/tenantConfig", () => ({
  getTenantSettings: async (tenantId: number) => ({ business: { publicBusinessName: `Tenant ${tenantId} Shop`, supportPhone: null, businessAddress: {}, timezone: "UTC" } }),
}));
vi.mock("../../config/brandingConfig", () => ({ getBranding: async () => null }));
vi.mock("../../lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/inventoryBalances", () => ({
  getCatalogInventorySnapshot: async () => ({ locations: [], items: [
    { id: 1, name: "Item A", sku: "SKU-A", stockUnit: "#", locations: [{ locationId: 4, qty: 2, par: 10 }, { locationId: 2, qty: 9, par: 10 }] },
  ] }),
}));
vi.mock("@clerk/express", () => ({ getAuth: () => ({ userId: "clerk" }), clerkMiddleware: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: async () => 1 }));

const { default: printRouter } = await import("../print");
const { default: printingRouter } = await import("../printing");
const { default: shiftsRouter } = await import("../shifts");
const { resolveDocumentPrinter } = await import("../../lib/print/printRouting");
const { queueDocumentPrint } = await import("../../lib/print/documentJobs");
const { buildClockSlip } = await import("../../lib/print/documents");
const { setBridgeKey, bridgeKeyFingerprint } = await import("../../lib/print/bridgeKey");
/**
 * The job types production accepts: the IN list of the last journaled
 * migration that (re)defines print_jobs_job_type_check, in journal order.
 */
function productionJobTypes(): Set<string> {
  const dir = resolve(import.meta.dirname, "../../../../../lib/db/drizzle");
  const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  let allowed: string[] | null = null;
  for (const { tag } of journal.entries) {
    const sql = readFileSync(resolve(dir, `${tag}.sql`), "utf8");
    const at = sql.search(/ADD CONSTRAINT "print_jobs_job_type_check"/);
    if (at < 0) continue;
    const list = sql.slice(at).match(/IN \(([^)]*)\)/)![1]!;
    allowed = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }
  return new Set(allowed ?? []);
}
store.allowedJobTypes = productionJobTypes();

const app = express();
app.use(express.json());
app.use("/api", printRouter);
app.use("/api", printingRouter);
app.use("/api", shiftsRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: err.message }); });
const api = supertest(app);

const asUser = (tenantId: number, role = "admin") => {
  store.user = { id: tenantId * 100, role, status: "approved", isActive: true, tenantId, email: `u@t${tenantId}`, firstName: "Luke", lastName: "Sample" };
};

// Tenant 1: Mac bridge (id 10) with an 80mm Brightek and a full-page office printer;
// Box 2 Pi bridge (id 11) with a 50mm location printer at location 4.
// Tenant 2: its own bridge (20) and printer (21).
function seed() {
  store.tables = {
    printBridgeProfilesTable: [
      { id: 10, tenantId: 1, name: "Production Mac Studio", isActive: true },
      { id: 11, tenantId: 1, name: "Raspberry Pi - Box 2", isActive: true },
      { id: 12, tenantId: 1, name: "Retired", isActive: false },
      { id: 20, tenantId: 2, name: "Other tenant bridge", isActive: true },
    ],
    printPrintersTable: [
      { id: 1, tenantId: 1, name: "Brightek POS80", role: "receipt", printerClass: "thermal", paperWidth: "80mm", routingScope: "general", locationId: null, bridgeProfileId: 10, bridgePrinterName: "Brightek_POS80", isActive: true, copies: 1, connectionType: "bridge", bridgeUrl: "http://mac:3100" },
      { id: 2, tenantId: 1, name: "Office Laser", role: "report", printerClass: "full_page", paperWidth: "letter", routingScope: "general", locationId: null, bridgeProfileId: 10, bridgePrinterName: "Office_Laser", isActive: true, copies: 1, connectionType: "bridge", bridgeUrl: "http://mac:3100" },
      { id: 3, tenantId: 1, name: "Box 2 Thermal", role: "receipt", printerClass: "thermal", paperWidth: "50mm", routingScope: "location", locationId: 4, bridgeProfileId: 11, bridgePrinterName: "Box2_Receipt", isActive: true, copies: 1, connectionType: "bridge", bridgeUrl: "http://pi:3100" },
      { id: 4, tenantId: 1, name: "Old Printer", role: "receipt", printerClass: "thermal", paperWidth: "80mm", routingScope: "general", locationId: null, bridgeProfileId: 12, bridgePrinterName: "Old", isActive: true, copies: 1, connectionType: "bridge" },
      { id: 5, tenantId: 1, name: "Inactive", role: "receipt", printerClass: "thermal", paperWidth: "80mm", routingScope: "general", locationId: null, bridgeProfileId: 10, bridgePrinterName: "Inactive", isActive: false, copies: 1, connectionType: "bridge" },
      { id: 21, tenantId: 2, name: "Other tenant printer", role: "receipt", printerClass: "thermal", paperWidth: "80mm", routingScope: "general", locationId: null, bridgeProfileId: 20, bridgePrinterName: "Other", isActive: true, copies: 1, connectionType: "bridge" },
    ],
    inventoryLocationsTable: [
      { id: 2, tenantId: 1, name: "Storefront", isActive: true, csrBoxId: null },
      { id: 4, tenantId: 1, name: "CSR Sales Box 2", isActive: true, csrBoxId: 7 },
      { id: 9, tenantId: 2, name: "Other tenant location", isActive: true, csrBoxId: null },
    ],
    csrBoxesTable: [{ id: 7, tenantId: 1, slug: "box-2" }],
    usersTable: [{ id: 555, firstName: "Casey", lastName: "Jones" }],
    printRoutesTable: [],
    printJobsTable: [],
  };
  store.nextId = 1000;
  store.legacyPrinter = null;
}
const route = (row: Row) => (store.tables.printRoutesTable!.push({ id: store.nextId++, isActive: true, ...row }), row);
const jobs = () => store.tables.printJobsTable ?? [];

beforeEach(() => {
  seed();
  dispatchJob.mockClear();
  asUser(1);
});

describe("deterministic routing", () => {
  it("prefers the location route, then the tenant default, and picks exactly one printer", async () => {
    route({ tenantId: 1, locationId: null, jobType: "ORDER_RECEIPT", printerId: 1, bridgeProfileId: 10 });
    route({ tenantId: 1, locationId: 4, jobType: "ORDER_RECEIPT", printerId: 3, bridgeProfileId: 11 });
    const box2 = await resolveDocumentPrinter({ tenantId: 1, locationId: 4, documentType: "ORDER_RECEIPT" });
    expect(box2).toMatchObject({ ok: true, source: "location-route", printer: { id: 3 } });
    const storefront = await resolveDocumentPrinter({ tenantId: 1, locationId: 2, documentType: "ORDER_RECEIPT" });
    expect(storefront).toMatchObject({ ok: true, source: "tenant-route", printer: { id: 1 } });
  });

  it("uses the legacy printer only for thermal documents with no route", async () => {
    store.legacyPrinter = store.tables.printPrintersTable![0]!;
    const legacyFallback = async () => store.legacyPrinter as never;
    expect(await resolveDocumentPrinter({ tenantId: 1, locationId: null, documentType: "CLOCK_IN", legacyFallback }))
      .toMatchObject({ ok: true, source: "legacy-fallback", printer: { id: 1 } });
    expect(await resolveDocumentPrinter({ tenantId: 1, locationId: null, documentType: "REPORT", legacyFallback }))
      .toMatchObject({ ok: false });
    expect(await resolveDocumentPrinter({ tenantId: 1, locationId: null, documentType: "WORK" })).toMatchObject({ ok: false });
  });

  it.each([
    ["class mismatch", { jobType: "REPORT", printerId: 1, bridgeProfileId: 10 }, "full-page"],
    ["thermal document on full-page printer", { jobType: "ORDER_RECEIPT", printerId: 2, bridgeProfileId: 10 }, "thermal"],
    ["inactive printer", { jobType: "ORDER_RECEIPT", printerId: 5, bridgeProfileId: 10 }, "inactive"],
    ["inactive bridge", { jobType: "ORDER_RECEIPT", printerId: 4, bridgeProfileId: 12 }, "bridge"],
    ["another tenant's printer", { jobType: "ORDER_RECEIPT", printerId: 21, bridgeProfileId: 20 }, "not found"],
    ["route bridge differs from printer", { jobType: "ORDER_RECEIPT", printerId: 1, bridgeProfileId: 11 }, "bridge"],
  ])("fails closed on a misconfigured route (%s) instead of falling back", async (_name, routeRow, reason) => {
    store.legacyPrinter = store.tables.printPrintersTable![0]!;
    route({ tenantId: 1, locationId: null, ...routeRow });
    const result = await resolveDocumentPrinter({ tenantId: 1, locationId: null, documentType: routeRow.jobType as never, legacyFallback: async () => store.legacyPrinter as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("never uses a location printer for a different location", async () => {
    route({ tenantId: 1, locationId: 2, jobType: "EXPO", printerId: 3, bridgeProfileId: 11 });
    expect(await resolveDocumentPrinter({ tenantId: 1, locationId: 2, documentType: "EXPO" })).toMatchObject({ ok: false });
  });
});

describe("document jobs", () => {
  const clock = () => buildClockSlip({ event: "in", businessName: "Shop", locationName: "Box 2", employeeName: "Casey J.", at: "2026-09-28T10:00:00.000Z", timezone: "UTC", shiftRef: "1" });

  it("renders thermal documents at the chosen printer's width and keeps the printer's scope", async () => {
    route({ tenantId: 1, locationId: 4, jobType: "CLOCK_IN", printerId: 3, bridgeProfileId: 11 });
    const result = await queueDocumentPrint({ tenantId: 1, locationId: 4, documentType: "CLOCK_IN", jobType: "shift_clock_in", idempotencyKey: "k1", render: { kind: "thermal", lines: clock } });
    expect(result.status).toBe("queued");
    const [job] = jobs();
    expect(job).toMatchObject({ printerId: 3, locationId: 4, renderFormat: "text", status: "queued", jobType: "shift_clock_in" });
    expect(String(job!.renderedText).startsWith("\x1b@")).toBe(true);
    // 50mm roll: 32 columns.
    // eslint-disable-next-line no-control-regex -- inspecting printer bytes
    const widest = String(job!.renderedText).replace(/\x1b[aE!d].|\x1d!.|\x1b@|\x1dVA./g, "").split("\n").reduce((max, line) => Math.max(max, line.length), 0);
    expect(widest).toBeLessThanOrEqual(32);
  });

  it("renders full-page documents as PDF, and a general printer gets a general-scope job", async () => {
    route({ tenantId: 1, locationId: null, jobType: "REPORT", printerId: 2, bridgeProfileId: 10 });
    const result = await queueDocumentPrint({ tenantId: 1, locationId: 4, documentType: "REPORT", jobType: "report", idempotencyKey: "k2",
      render: { kind: "report", report: () => ({ title: "R", businessName: "B", generatedAt: "2026-01-01T00:00:00Z", timezone: "UTC", sections: [] }) } });
    expect(result.status).toBe("queued");
    const [job] = jobs();
    expect(job).toMatchObject({ printerId: 2, locationId: null, renderFormat: "pdf" });
    const payload = job!.payloadJson as Record<string, unknown>;
    expect(Buffer.from(String(payload.pdfBase64), "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(payload.contextLocationId).toBe(4);
  });

  it("is idempotent on its key and records a failed job when nothing is routed", async () => {
    const first = await queueDocumentPrint({ tenantId: 1, locationId: null, documentType: "WORK", jobType: "order_ticket", idempotencyKey: "k3", render: { kind: "thermal", lines: clock } });
    expect(first).toMatchObject({ status: "no-route" });
    expect(jobs()[0]).toMatchObject({ status: "failed", printerId: null });
    const again = await queueDocumentPrint({ tenantId: 1, locationId: null, documentType: "WORK", jobType: "order_ticket", idempotencyKey: "k3", render: { kind: "thermal", lines: clock } });
    expect(again.status).toBe("duplicate");
    expect(jobs()).toHaveLength(1);
  });
});

describe("printing admin API", () => {
  it("sets a route only to a compatible printer of this tenant", async () => {
    const cases: Array<[Row, number]> = [
      [{ documentType: "REPORT", locationId: null, printerId: 1 }, 400],
      [{ documentType: "ORDER_RECEIPT", locationId: null, printerId: 21 }, 400],
      [{ documentType: "ORDER_RECEIPT", locationId: 9, printerId: 1 }, 400],
      [{ documentType: "ORDER_RECEIPT", locationId: 2, printerId: 3 }, 400],
      [{ documentType: "ORDER_RECEIPT", locationId: null, printerId: 1, bridgePrinterName: "x" }, 400],
      [{ documentType: "NOT_A_TYPE", locationId: null, printerId: 1 }, 400],
    ];
    for (const [body, status] of cases) expect((await api.put("/api/print/routes").send(body)).status).toBe(status);
    expect(store.tables.printRoutesTable).toHaveLength(0);

    const ok = await api.put("/api/print/routes").send({ documentType: "ORDER_RECEIPT", locationId: 4, printerId: 3 });
    expect(ok.status).toBe(200);
    expect(store.tables.printRoutesTable![0]).toMatchObject({ tenantId: 1, locationId: 4, jobType: "ORDER_RECEIPT", printerId: 3, bridgeProfileId: 11, isActive: true });
    const moved = await api.put("/api/print/routes").send({ documentType: "ORDER_RECEIPT", locationId: 4, printerId: 1 });
    expect(moved.status).toBe(200);
    expect(store.tables.printRoutesTable).toHaveLength(1);
    expect((store.tables.auditLogsTable ?? []).filter((r) => r.action === "PRINT_ROUTE_SET").at(-1)!.metadata).toMatchObject({ printerId: 1, previousPrinterId: 3 });
  });

  it("never shows or changes another tenant's routes", async () => {
    route({ tenantId: 2, locationId: 9, jobType: "ORDER_RECEIPT", printerId: 21, bridgeProfileId: 20 });
    const other = store.tables.printRoutesTable![0]!;
    expect((await api.get("/api/print/routes")).body.routes).toEqual([]);
    expect((await api.delete(`/api/print/routes/${other.id}`)).status).toBe(404);
    expect(other.isActive).toBe(true);
    const matrix = await api.get("/api/print/routing-matrix");
    expect(JSON.stringify(matrix.body)).not.toMatch(/Other tenant/);
  });

  it.each(["csr", "supervisor", "customer"])("rejects %s on every printing admin route", async (role) => {
    asUser(1, role);
    const results = await Promise.all([
      api.get("/api/print/routes"),
      api.put("/api/print/routes").send({ documentType: "ORDER_RECEIPT", locationId: null, printerId: 1 }),
      api.get("/api/print/routing-matrix"),
      api.post("/api/print/documents/preview").send({ documentType: "CLOCK_IN" }),
      api.post("/api/print/documents/test").send({ documentType: "CLOCK_IN", printerId: 1 }),
      api.get("/api/print/inventory/stock-list.pdf?locationId=4"),
      api.post("/api/print/inventory/stock-list/print").send({ locationId: 4 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(jobs()).toHaveLength(0);
  });

  it("reports what prints where, including legacy fallbacks and gaps", async () => {
    route({ tenantId: 1, locationId: 4, jobType: "EXPO", printerId: 3, bridgeProfileId: 11 });
    store.legacyPrinter = store.tables.printPrintersTable![0]!;
    const { body } = await api.get("/api/print/routing-matrix");
    const cell = (locationId: number | null, documentType: string) => body.cells.find((c: Row) => c.locationId === locationId && c.documentType === documentType);
    expect(cell(4, "EXPO")).toMatchObject({ printerName: "Box 2 Thermal", bridgeName: "Raspberry Pi - Box 2", source: "location-route" });
    expect(cell(null, "ORDER_RECEIPT")).toMatchObject({ printerName: "Brightek POS80", source: "legacy-fallback" });
    expect(cell(null, "REPORT")).toMatchObject({ printerName: null, problem: expect.stringContaining("No print route") });
  });
});

describe("previews and test prints", () => {
  it("previews every document type without creating a job", async () => {
    for (const documentType of ["ORDER_RECEIPT", "CLOCK_IN", "CLOCK_OUT", "DEPOSIT", "EXPO", "WORK"]) {
      const res = await api.post("/api/print/documents/preview").send({ documentType, paperWidth: "50mm" });
      expect(res.status).toBe(200);
      expect(res.text.startsWith("*** SAMPLE / PREVIEW - NOT PRINTED ***")).toBe(true);
      // eslint-disable-next-line no-control-regex -- inspecting printer bytes
      expect(res.text).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
    }
    for (const documentType of ["INVENTORY_STOCK_LIST", "REPORT"]) {
      const res = await api.post("/api/print/documents/preview").send({ documentType }).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    }
    expect(jobs()).toHaveLength(0);
    expect(dispatchJob).not.toHaveBeenCalled();
  });

  it("test prints need an explicit compatible printer of this tenant and never accept a queue", async () => {
    const results = await Promise.all([
      api.post("/api/print/documents/test").send({ documentType: "CLOCK_IN" }),
      api.post("/api/print/documents/test").send({ documentType: "CLOCK_IN", printerId: 1, bridgePrinterName: "Anything" }),
      api.post("/api/print/documents/test").send({ documentType: "CLOCK_IN", printerId: 1, queue: "lp -d x" }),
      api.post("/api/print/documents/test").send({ documentType: "CLOCK_IN", printerId: 21 }),
      api.post("/api/print/documents/test").send({ documentType: "REPORT", printerId: 1 }),
      api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 5 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 404, 409, 409]);
    expect(jobs()).toHaveLength(0);

    const ok = await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 3, testId: "t-1" });
    expect(ok.body).toMatchObject({ ok: true, status: "printed", testId: "t-1" });
    const [job] = jobs();
    expect(job).toMatchObject({ printerId: 3, jobType: "document_test", renderFormat: "text", locationId: 4 });
    expect(String(job!.renderedText)).toContain("*** TEST PRINT ***");
    // No tenant template: the fallback receipt for the fixed sample order.
    expect(String(job!.renderedText)).toContain("SAMPLE-0001");
    expect(dispatchJob).toHaveBeenCalledTimes(1);

    const pdf = await api.post("/api/print/documents/test").send({ documentType: "INVENTORY_STOCK_LIST", printerId: 2, testId: "t-2" });
    expect(pdf.body.ok).toBe(true);
    expect(jobs()[1]).toMatchObject({ printerId: 2, renderFormat: "pdf" });
  });
});

describe("test print against production's print_jobs constraints", () => {
  // Visible text of a thermal job: ESC/POS commands removed.
  // eslint-disable-next-line no-control-regex -- stripping printer command bytes
  const visibleLines = (text: string) => text.replace(/\x1b[@-~]|\x1b[!-/]./g, "").replace(/\x1d[!-~]./g, "").replace(/[\x00-\x09\x0b-\x1f]/g, "").split("\n");

  it("production admits every job type the printing code writes, and nothing arbitrary", async () => {
    const { DOCUMENT_TYPES, PRINT_DOCUMENT_TYPES } = await import("../../lib/print/documentTypes");
    const written = new Set(["document_test", ...PRINT_DOCUMENT_TYPES.flatMap((type) => [...DOCUMENT_TYPES[type].jobTypes])]);
    for (const jobType of written) expect(store.allowedJobTypes!.has(jobType), jobType).toBe(true);
    expect(store.allowedJobTypes!.has("anything_else")).toBe(false);
  });

  it("Brightek 80mm: an Order receipt test print creates one general job, fits 48 columns and dispatches once", async () => {
    const res = await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 1, testId: "brightek-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "printed", testId: "brightek-1" });
    expect(jobs()).toHaveLength(1);
    const [job] = jobs();
    expect(job).toMatchObject({ printerId: 1, jobType: "document_test", locationId: null, maxRetries: 1 });
    const lines = visibleLines(String(job!.renderedText));
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(48);
    expect(Math.max(...lines.map((line) => line.length))).toBeGreaterThan(32);
    expect(dispatchJob).toHaveBeenCalledTimes(1);
  });

  it("Box 2 50mm: an Order receipt test print keeps the Box 2 scope and fits 32 columns", async () => {
    const res = await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 3, testId: "box2-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "printed" });
    const [job] = jobs();
    expect(job).toMatchObject({ printerId: 3, jobType: "document_test", locationId: 4 });
    expect(Math.max(...visibleLines(String(job!.renderedText)).map((line) => line.length))).toBeLessThanOrEqual(32);
    expect(dispatchJob).toHaveBeenCalledTimes(1);
  });

  it("every thermal document type can be test printed on the chosen printer", async () => {
    for (const documentType of ["CLOCK_IN", "CLOCK_OUT", "DEPOSIT", "EXPO", "WORK"]) {
      const res = await api.post("/api/print/documents/test").send({ documentType, printerId: 3, testId: `box2-${documentType}` });
      expect(res.status, documentType).toBe(200);
    }
    expect(jobs().map((job) => job.printerId)).toEqual([3, 3, 3, 3, 3]);
    expect(dispatchJob).toHaveBeenCalledTimes(5);
  });

  it("validates the document type and enforces tenant and role", async () => {
    expect((await api.post("/api/print/documents/test").send({ documentType: "NOT_A_DOCUMENT", printerId: 1 })).status).toBe(400);
    asUser(2);
    expect((await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 3 })).status).toBe(404);
    asUser(1, "staff");
    expect((await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 3 })).status).toBe(403);
    expect(jobs()).toHaveLength(0);
    expect(dispatchJob).not.toHaveBeenCalled();
  });

  it("reports a failed dispatch without retrying or re-sending it", async () => {
    dispatchJob.mockImplementationOnce(async (job: { id: number }) => {
      const row = store.tables.printJobsTable!.find((r) => r.id === job.id)!;
      Object.assign(row, { status: "failed", errorMessage: "Bridge unreachable" });
    });
    const res = await api.post("/api/print/documents/test").send({ documentType: "ORDER_RECEIPT", printerId: 3, testId: "box2-fail" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: "failed", error: "Bridge unreachable" });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ maxRetries: 1 });
    expect(dispatchJob).toHaveBeenCalledTimes(1);
  });
});

describe("printer registration: classes and widths", () => {
  it.each([
    [{ printerClass: "thermal", paperWidth: "58mm" }, 400],
    [{ printerClass: "thermal", paperWidth: "112mm" }, 400],
    [{ printerClass: "full_page", paperWidth: "80mm" }, 400],
    [{ printerClass: "dot_matrix" }, 400],
  ])("rejects %j", async (extra, status) => {
    const res = await api.post("/api/print/printers").send({ name: "P", role: "receipt", connectionType: "bridge", bridgeProfileId: 10, bridgePrinterName: "P1", ...extra });
    expect(res.status).toBe(status);
  });

  it("stores thermal 50mm and full-page Letter printers", async () => {
    const thermal = await api.post("/api/print/printers").send({ name: "T", role: "receipt", connectionType: "bridge", bridgeProfileId: 10, bridgePrinterName: "T1", printerClass: "thermal", paperWidth: "50mm" });
    const page = await api.post("/api/print/printers").send({ name: "L", role: "report", connectionType: "bridge", bridgeProfileId: 10, bridgePrinterName: "L1", printerClass: "full_page" });
    expect(thermal.body.printer).toMatchObject({ printerClass: "thermal", paperWidth: "50mm" });
    expect(page.body.printer).toMatchObject({ printerClass: "full_page", paperWidth: "letter" });
  });
});

describe("full-page stock list", () => {
  it("renders a PDF for the tenant's location only", async () => {
    const res = await api.get("/api/print/inventory/stock-list.pdf?locationId=4").buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await api.get("/api/print/inventory/stock-list.pdf?locationId=9")).status).toBe(404);
  });

  it("prints only through a full-page route", async () => {
    expect((await api.post("/api/print/inventory/stock-list/print").send({ locationId: 4 })).status).toBe(503);
    route({ tenantId: 1, locationId: null, jobType: "INVENTORY_STOCK_LIST", printerId: 2, bridgeProfileId: 10 });
    const res = await api.post("/api/print/inventory/stock-list/print").send({ locationId: 4 });
    expect(res.body).toMatchObject({ ok: true, printerName: "Office Laser" });
    expect(jobs().at(-1)).toMatchObject({ jobType: "inventory_stock_list", renderFormat: "pdf", printerId: 2 });
  });
});

describe("restock-slip print: tenant boundary (BOLA) repair", () => {
  function seedShift(tenantId: number, id: number) {
    (store.tables.labTechShiftsTable ??= []).push({ id, tenantId, techId: 555, boxAssignmentId: "box-2", clockedInAt: new Date("2026-09-28T08:00:00Z"), clockedOutAt: null, cashBankStart: "100.00", status: "active" });
    (store.tables.shiftInventoryItemsTable ??= []).push({ id: id * 10, shiftId: id, rowType: "item", itemName: "Item A", sectionName: "S", unitType: "#", quantityStart: "10", quantitySold: "3", quantityEndActual: "2", templateItemId: 70, isFlagged: false, displayOrder: 1 });
    (store.tables.inventoryTemplatesTable ??= []).push({ id: 70, parLevel: "10" });
  }

  it("refuses another tenant's shift with the same 404 as a missing shift, creating nothing", async () => {
    seedShift(2, 7001);
    route({ tenantId: 1, locationId: null, jobType: "INVENTORY_STOCK_LIST", printerId: 2, bridgeProfileId: 10 });
    const res = await api.post("/api/shifts/7001/restock-slip/print").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Shift not found" });
    const missing = await api.post("/api/shifts/999999/restock-slip/print").send({});
    expect(missing.body).toEqual(res.body);
    expect(jobs()).toHaveLength(0);
    expect(dispatchJob).not.toHaveBeenCalled();
  });

  it("also hides another tenant's restock data and shift summary", async () => {
    seedShift(2, 7002);
    expect((await api.get("/api/shifts/7002/restock-slip")).status).toBe(404);
  });

  it("prints the tenant's own restock list as a routed full-page job and audits it", async () => {
    seedShift(1, 7003);
    route({ tenantId: 1, locationId: 4, jobType: "INVENTORY_STOCK_LIST", printerId: 2, bridgeProfileId: 10 });
    const res = await api.post("/api/shifts/7003/restock-slip/print").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, printed: true, itemCount: 1, shiftId: 7003 });
    const [job] = jobs();
    expect(job).toMatchObject({ tenantId: 1, jobType: "shift_restock", printerId: 2, renderFormat: "pdf", shiftId: 7003 });
    const audit = (store.tables.auditLogsTable ?? []).find((row) => row.action === "shift.restock_list_printed");
    expect(audit).toMatchObject({ tenantId: 1, actorId: 100, resourceId: "7003", metadata: { printJobId: job!.id, printerId: 2 } });
    expect(JSON.stringify(audit)).not.toContain("Item A");
  });

  it("returns 503 instead of printing anywhere when no full-page route exists", async () => {
    seedShift(1, 7004);
    route({ tenantId: 1, locationId: null, jobType: "INVENTORY_STOCK_LIST", printerId: 1, bridgeProfileId: 10 }); // thermal: invalid
    const res = await api.post("/api/shifts/7004/restock-slip/print").send({});
    expect(res.status).toBe(503);
    expect(jobs()).toHaveLength(0);
  });

  it("has no direct lp path left in live code", () => {
    const src = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
    for (const file of ["routes/shifts.ts", "routes/print.ts", "routes/printing.ts", "routes/admin-printers.ts", "lib/simplePrint.ts", "lib/printService.ts"]) {
      expect(src(file)).not.toMatch(/child_process|escposPrinter|printReceiptEscPos|spawn\("lp"/);
    }
  });
});

describe("receipt designer support: fields, versions, defaults", () => {
  const LAYOUT = [{ type: "data", id: "t", field: "total" }];
  function seedTemplate(tenantId: number, extra: Row = {}) {
    const row = { id: store.nextId++, tenantId, name: `T${tenantId}`, jobType: "receipt", version: 2, schemaVersion: 1, paperWidth: "80mm", paperHeight: "auto", isActive: true, isDefault: true, templateJson: LAYOUT, backgroundAssetId: null, ...extra };
    (store.tables.printTemplatesTable ??= []).push(row);
    (store.tables.printTemplateVersionsTable ??= []).push(
      { id: store.nextId++, tenantId, templateId: row.id, version: 1, templateJson: [{ type: "data", id: "n", field: "orderNumber" }], paperWidth: "50mm", createdAt: new Date() },
      { id: store.nextId++, tenantId, templateId: row.id, version: 2, templateJson: LAYOUT, paperWidth: "80mm", createdAt: new Date() },
    );
    return row;
  }

  it("offers only fields the engine renders (no logo or QR)", async () => {
    const { body } = await api.get("/api/print/templates/receipt-fields");
    const fields = body.fields.map((f: Row) => f.field);
    expect(fields).toContain("items");
    expect(fields).toContain("paymentReference");
    expect(fields).not.toContain("logo");
    expect(fields).not.toContain("qrCode");
    expect(body.paperWidths).toEqual(["50mm", "80mm"]);
  });

  it("lists and restores only the tenant's own versions, appending a new version", async () => {
    const other = seedTemplate(2);
    expect((await api.get(`/api/print/templates/${other.id}/versions`)).status).toBe(404);
    expect((await api.post(`/api/print/templates/${other.id}/versions/1/restore`)).status).toBe(404);
    expect(other.version).toBe(2);

    const mine = seedTemplate(1);
    const versions = await api.get(`/api/print/templates/${mine.id}/versions`);
    expect(versions.body.versions.map((v: Row) => v.version).sort()).toEqual([1, 2]);
    const restored = await api.post(`/api/print/templates/${mine.id}/versions/1/restore`);
    expect(restored.status).toBe(200);
    expect(mine).toMatchObject({ version: 3, paperWidth: "50mm", templateJson: [{ type: "data", id: "n", field: "orderNumber" }] });
    const mineVersions = store.tables.printTemplateVersionsTable!.filter((v) => v.templateId === mine.id).map((v) => v.version);
    expect(mineVersions).toEqual([1, 2, 3]);
  });

  it("refuses to restore a version the current rules reject", async () => {
    const mine = seedTemplate(1);
    store.tables.printTemplateVersionsTable!.push({ id: store.nextId++, tenantId: 1, templateId: mine.id, version: 9, templateJson: [{ type: "html", id: "x" }], paperWidth: "80mm" });
    expect((await api.post(`/api/print/templates/${mine.id}/versions/9/restore`)).status).toBe(409);
    expect(mine.version).toBe(2);
  });

  it("rejects a stale save and non-roll widths, and keeps one default receipt template", async () => {
    const first = seedTemplate(1);
    const stale = await api.patch(`/api/print/templates/${first.id}`).send({ expectedVersion: 1, templateJson: LAYOUT });
    expect(stale.status).toBe(409);
    expect((await api.patch(`/api/print/templates/${first.id}`).send({ paperWidth: "58mm" })).status).toBe(400);
    expect((await api.post("/api/print/templates").send({ name: "x", jobType: "receipt", templateJson: LAYOUT, paperWidth: "112mm" })).status).toBe(400);

    const created = await api.post("/api/print/templates").send({ name: "New", jobType: "receipt", templateJson: LAYOUT, paperWidth: "50mm", isDefault: true });
    expect(created.status).toBe(201);
    const defaults = store.tables.printTemplatesTable!.filter((t) => t.tenantId === 1 && t.isDefault);
    expect(defaults.map((t) => t.name)).toEqual(["New"]);
  });
});

describe("operator bridge-key command", () => {
  const KEY = "a".repeat(20) + "0123456789abcdef0123456789abcdef";
  beforeEach(() => {
    store.tables.usersTable!.push(
      { id: 100, tenantId: 1, role: "admin", isActive: true, email: "admin@t1" },
      { id: 200, tenantId: 2, role: "admin", isActive: true, email: "admin@t2" },
      { id: 300, tenantId: 1, role: "csr", isActive: true, email: "csr@t1" },
    );
  });

  it("sets the tenant's bridge key and audits only its fingerprint", async () => {
    const result = await setBridgeKey({ tenantId: 1, bridgeId: 11, actorId: 100, key: `${KEY}\n` });
    expect(result).toEqual({ bridgeId: 11, tenantId: 1, fingerprint: bridgeKeyFingerprint(KEY) });
    expect(store.tables.printBridgeProfilesTable!.find((b) => b.id === 11)!.apiKey).toBe(KEY);
    const audit = store.tables.auditLogsTable!.find((r) => r.action === "PRINT_BRIDGE_KEY_SET");
    expect(audit).toMatchObject({ tenantId: 1, actorId: 100, resourceId: "11", metadata: { fingerprint: bridgeKeyFingerprint(KEY) } });
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  it.each([
    [{ tenantId: 1, bridgeId: 20, actorId: 100 }, "Bridge not found"],
    [{ tenantId: 1, bridgeId: 11, actorId: 200 }, "Actor must be"],
    [{ tenantId: 1, bridgeId: 11, actorId: 300 }, "Actor must be"],
    [{ tenantId: 1, bridgeId: 11, actorId: 999 }, "Actor must be"],
  ])("refuses %j", async (input, message) => {
    await expect(setBridgeKey({ ...input, key: KEY })).rejects.toThrow(message);
    expect(store.tables.printBridgeProfilesTable!.find((b) => b.id === 20)!.apiKey).toBeUndefined();
    expect(store.tables.printBridgeProfilesTable!.find((b) => b.id === 11)!.apiKey).toBeUndefined();
  });

  it.each(["short", "has space " + KEY, "x".repeat(257)])("rejects a malformed key", async (key) => {
    await expect(setBridgeKey({ tenantId: 1, bridgeId: 11, actorId: 100, key })).rejects.toThrow("32-256");
  });
});

