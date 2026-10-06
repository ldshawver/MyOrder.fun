/**
 * Per-tenant automatic-print controls: default OFF, tenant isolation,
 * optimistic concurrency (stale screens cannot re-enable flags), atomic
 * pause-all, audit trail, and the legacy settings endpoints no longer
 * writing automatic-print flags.
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
  nextId: 1,
  locks: 0,
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
  const db: Record<string, unknown> = {
    select: (fields?: Record<string, Col>) => ({
      from: (t: Record<string, unknown>) => {
        let pred: Pred | undefined;
        let max = Infinity;
        const run = () => rows(t).filter((r) => matches(r, pred)).slice(0, max).map((r) => project(r, fields));
        const chain: Record<string, unknown> = {
          where: (p: Pred) => ((pred = p), chain),
          orderBy: () => chain,
          limit: (n: number) => ((max = n), chain),
          for: () => { store.locks++; return chain; },
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
        };
        return chain;
      },
    }),
    insert: (t: Record<string, unknown>) => ({
      values: (v: Row) => {
        const insertRow = () => {
          const row = { id: store.nextId++, ...v };
          rows(t).push(row);
          return row;
        };
        const done = () => Promise.resolve([insertRow()]);
        return {
          returning: done,
          then: (ok: (v: unknown) => unknown) => done().then(ok),
          onConflictDoUpdate: ({ target, set }: { target: Col; set: Row }) => ({
            returning: () => {
              const existing = rows(t).find((r) => r[target.col] === v[target.col]);
              if (existing) { Object.assign(existing, set); return Promise.resolve([existing]); }
              return done();
            },
          }),
        };
      },
    }),
    update: (t: Record<string, unknown>) => ({
      set: (u: Row) => ({
        where: (p: Pred) => {
          const hit = rows(t).filter((r) => matches(r, p));
          hit.forEach((r) => Object.assign(r, u));
          const result = Promise.resolve(hit);
          return { returning: () => result, then: result.then.bind(result) };
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve([]) }),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  const names = [
    "printPrintersTable", "printBridgeProfilesTable", "printJobsTable", "printJobAttemptsTable",
    "printSettingsTable", "operatorPrintProfilesTable", "printTemplatesTable", "printAssetsTable",
    "usersTable", "ordersTable", "orderItemsTable", "adminSettingsTable", "auditLogsTable",
    "printTemplateVersionsTable", "inventoryLocationsTable", "shiftPrintAssignmentsTable", "printRoutesTable",
    "paymentAttemptsTable", "paymentCapturesTable", "tenantPrintControlsTable",
  ];
  return { db, ...Object.fromEntries(names.map((n) => [n, table(n)])) };
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
}));
vi.mock("../../lib/printService", () => ({
  dispatchJob: vi.fn(), dispatchReceiptJob: vi.fn(), dispatchLabelJob: vi.fn(), makeIdempotencyKey: vi.fn(),
  getSettings: async () => (store.tables.printSettingsTable ??= [{
    id: 1, paperWidth: "80mm", brandName: null, footerMessage: null,
    // Legacy global columns left ON on purpose: they must no longer matter.
    autoPrintOrders: true, autoPrintReceipts: true, autoPrintLabels: true,
  }])[0],
}));
vi.mock("../../lib/printRouter", () => ({
  selectActiveOperator: vi.fn(), probePrinter: vi.fn(), resolveReceiptPrinters: vi.fn(), resolveLabelPrinter: vi.fn(),
  resolveBridgeApiKey: (key: string | null) => key || "central-key",
}));
vi.mock("../../config/tenantConfig", () => ({ getTenantSettings: vi.fn() }));
vi.mock("../../config/brandingConfig", () => ({ getBranding: vi.fn() }));
vi.mock("../../lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock("sharp", () => ({ default: vi.fn() }));

const { default: printRouter } = await import("../print");
const { default: adminPrintersRouter } = await import("../admin-printers");
const { getPrintControls } = await import("../../lib/printControls");
const app = express();
app.use(express.json());
app.use("/api", printRouter);
app.use("/api", adminPrintersRouter);
const api = supertest(app);

const asUser = (tenantId: number, role = "admin") => {
  store.user = { id: tenantId * 100, role, status: "approved", tenantId, email: `u@t${tenantId}` };
};
const controlsRow = (tenantId: number) => store.tables.tenantPrintControlsTable?.find((r) => r.tenantId === tenantId);
const audits = (action: string) => (store.tables.auditLogsTable ?? []).filter((r) => r.action === action);

beforeEach(() => {
  store.tables = {};
  store.nextId = 1;
  store.locks = 0;
  asUser(1);
});

describe("default OFF", () => {
  it("treats a tenant without a row as fully OFF, even if the legacy global row is ON", async () => {
    expect(await getPrintControls(1)).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false, version: 0 });
    const res = await api.get("/api/print/controls");
    expect(res.body.controls).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false, version: 0 });
    const legacy = await api.get("/api/print/settings");
    expect(legacy.body.settings).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false });
  });
});

describe("field-specific updates with concurrency protection", () => {
  it("changes only the supplied flag and bumps the version", async () => {
    const res = await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintReceipts: true });
    expect(res.status).toBe(200);
    expect(res.body.controls).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: true, autoPrintLabels: false, version: 1 });
    expect(controlsRow(1)).toMatchObject({ tenantId: 1, autoPrintReceipts: true, version: 1, updatedByUserId: 100 });
  });

  it("refuses a stale save and changes nothing", async () => {
    await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintReceipts: true });
    await api.post("/api/print/controls/pause-all").send({});
    // A screen loaded at version 1 (receipts ON) tries to turn labels on.
    const stale = await api.patch("/api/print/controls").send({ expectedVersion: 1, autoPrintLabels: true });
    expect(stale.status).toBe(409);
    expect(stale.body.controls).toMatchObject({ autoPrintReceipts: false, autoPrintLabels: false, version: 2 });
    expect(controlsRow(1)).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false, version: 2 });
  });

  it("never re-enables a flag the request did not mention", async () => {
    await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintReceipts: true, autoPrintLabels: true });
    const res = await api.patch("/api/print/controls").send({ expectedVersion: 1, autoPrintReceipts: false });
    expect(res.body.controls).toMatchObject({ autoPrintReceipts: false, autoPrintLabels: true, autoPrintOrders: false });
  });

  it.each([
    [{ autoPrintReceipts: true }, "missing expectedVersion"],
    [{ expectedVersion: 0 }, "no flag"],
    [{ expectedVersion: 0, autoPrintReceipts: "true" }, "non-boolean"],
    [{ expectedVersion: 0, autoPrintReceipts: true, tenantId: 2 }, "client tenant id"],
    [{ expectedVersion: 0, autoPrintReceipts: true, unknown: 1 }, "unknown field"],
  ])("rejects %j (%s)", async (body) => {
    const res = await api.patch("/api/print/controls").send(body);
    expect(res.status).toBe(400);
    expect(controlsRow(1)).toBeUndefined();
    expect(controlsRow(2)).toBeUndefined();
  });

  it("audits actor, tenant, previous and next values", async () => {
    await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintOrders: true });
    expect(audits("PRINT_CONTROLS_UPDATED")[0]).toMatchObject({
      tenantId: 1, actorId: 100, actorRole: "admin", resourceType: "tenant_print_controls", resourceId: "1",
      metadata: {
        previous: { autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false },
        next: { autoPrintOrders: true, autoPrintReceipts: false, autoPrintLabels: false },
        version: 1,
      },
    });
    expect(store.locks).toBeGreaterThan(0);
  });
});

describe("pause all", () => {
  it("sets all three OFF in one write, from any state, and audits it", async () => {
    await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintOrders: true, autoPrintReceipts: true, autoPrintLabels: true });
    const res = await api.post("/api/print/controls/pause-all").send({});
    expect(res.body.controls).toMatchObject({ autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false, version: 2 });
    expect(audits("PRINT_CONTROLS_PAUSED_ALL")[0]!.metadata).toMatchObject({
      previous: { autoPrintOrders: true, autoPrintReceipts: true, autoPrintLabels: true },
      next: { autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false },
    });
  });

  it("creates an explicit OFF row for a tenant with no row and ignores no parameters", async () => {
    expect((await api.post("/api/print/controls/pause-all").send({ tenantId: 2 })).status).toBe(400);
    const res = await api.post("/api/print/controls/pause-all").send({});
    expect(res.body.controls).toMatchObject({ autoPrintOrders: false, version: 1 });
    expect(controlsRow(2)).toBeUndefined();
  });
});

describe("tenant isolation and authorisation", () => {
  it("never reads or changes another tenant's controls", async () => {
    asUser(2);
    await api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintReceipts: true });
    asUser(1);
    expect((await api.get("/api/print/controls")).body.controls.autoPrintReceipts).toBe(false);
    await api.post("/api/print/controls/pause-all").send({});
    expect(controlsRow(2)).toMatchObject({ autoPrintReceipts: true, version: 1 });
    expect(controlsRow(1)).toMatchObject({ autoPrintReceipts: false });
  });

  it.each(["csr", "supervisor", "customer"])("rejects %s", async (role) => {
    asUser(1, role);
    const results = await Promise.all([
      api.get("/api/print/controls"),
      api.patch("/api/print/controls").send({ expectedVersion: 0, autoPrintReceipts: true }),
      api.post("/api/print/controls/pause-all").send({}),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(controlsRow(1)).toBeUndefined();
  });
});

describe("legacy settings endpoints cannot change automatic printing", () => {
  it("ignores auto-print fields in a stale full-object save to /print/settings", async () => {
    const res = await api.patch("/api/print/settings").send({
      footerMessage: "Thanks", autoPrintOrders: true, autoPrintReceipts: true, autoPrintLabels: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.ignoredFields).toEqual(["autoPrintOrders", "autoPrintReceipts", "autoPrintLabels"]);
    expect(res.body.settings).toMatchObject({ footerMessage: "Thanks", autoPrintReceipts: false });
    expect(controlsRow(1)).toBeUndefined();
    expect(audits("PRINT_CONTROLS_UPDATED")).toHaveLength(0);
  });

  it("ignores autoPrintReceipts on /admin/printers/settings and reports the tenant value", async () => {
    const res = await api.patch("/api/admin/printers/settings").send({ autoPrintReceipts: true });
    expect(res.body.ignoredFields).toEqual(["autoPrintReceipts"]);
    expect(res.body.settings.autoPrintReceipts).toBe(false);
    expect(controlsRow(1)).toBeUndefined();
  });
});

describe("automatic paths read tenant controls, not the global row", () => {
  const src = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

  it("order, auto-receipt and shift printing consult getPrintControls", () => {
    const printService = src("lib/printService.ts");
    expect(printService).toContain("const controls = await getPrintControls(tenantId);");
    expect(printService).not.toMatch(/settings\.autoPrint(Orders|Receipts|Labels)/);
    expect(src("lib/autoReceiptPrint.ts")).toContain("getPrintControls(order.tenantId)");
    expect(src("routes/shifts.ts")).toContain("if (!(await getPrintControls(tenantId)).autoPrintReceipts) return;");
    expect(src("routes/shifts.ts")).not.toMatch(/getSettings\(\)\)\.autoPrint/);
  });

  it("the migration cannot enable printing: no backfill, every flag defaults false", () => {
    const sqlText = readFileSync(resolve(import.meta.dirname, "../../../../../lib/db/drizzle/0062_tenant_print_controls.sql"), "utf8");
    const statements = sqlText.replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bCOPY\b/i);
    expect(statements.match(/"auto_print_(orders|receipts|labels)" boolean NOT NULL DEFAULT false/g)).toHaveLength(3);
    expect(statements).not.toMatch(/DEFAULT true/i);
    expect(statements).toContain('"tenant_id" integer PRIMARY KEY REFERENCES "tenants"("id")');
  });
});
