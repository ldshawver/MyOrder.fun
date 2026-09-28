/**
 * Behavioral tests for tenant-scoped print registration:
 * bridge profiles, registered printers, bridge probe, controlled test and
 * auto-print settings. The db is an in-memory fake that evaluates the route's
 * drizzle predicates, so tenant filters are exercised rather than asserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

type Row = Record<string, unknown>;
type Col = { table: string; col: string };
type Pred =
  | { op: "eq"; c: Col; v: unknown }
  | { op: "and" | "or"; p: Pred[] }
  | { op: "true" };

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  nextId: 1,
  user: { id: 1, role: "admin", status: "approved", tenantId: 1, email: "admin@t1" } as Record<string, unknown>,
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

const dispatchJob = vi.hoisted(() => vi.fn());
vi.mock("../../lib/printService", () => ({
  dispatchJob,
  dispatchReceiptJob: vi.fn(),
  dispatchLabelJob: vi.fn(),
  makeIdempotencyKey: vi.fn(),
  getSettings: async () => (store.tables.printSettingsTable ??= [{ id: 1, autoPrintOrders: true, autoPrintReceipts: true, autoPrintLabels: true }])[0],
}));
vi.mock("../../lib/printRouter", () => ({
  selectActiveOperator: vi.fn(),
  probePrinter: vi.fn(),
  resolveReceiptPrinters: vi.fn(),
  resolveLabelPrinter: vi.fn(),
  resolveBridgeApiKey: (key: string | null) => key || "central-key",
}));
vi.mock("../../lib/escposPrinter", () => ({ printReceiptEscPos: vi.fn() }));
vi.mock("../../lib/print/index", () => ({
  renderBlocks: vi.fn(), renderBodyOnly: vi.fn(), buildCustomerReceiptBlocks: vi.fn(),
  buildInventoryStartBlocks: vi.fn(), buildInventoryEndBlocks: vi.fn(), buildLabelBlocks: vi.fn(),
  getLogo: vi.fn(), charWidth: vi.fn(),
}));
vi.mock("sharp", () => ({ default: vi.fn() }));

const { default: printRouter } = await import("../print");
const app = express();
app.use(express.json());
app.use("/api", printRouter);
const api = supertest(app);

const asUser = (tenantId: number, role = "admin") => {
  store.user = { id: tenantId * 100, role, status: "approved", tenantId, email: `u@t${tenantId}` };
};
const createBridge = (body: Row = {}) =>
  api.post("/api/print/bridge-profiles").send({
    name: "Production Mac Studio",
    bridgeUrl: "http://100.104.253.117:3100",
    apiKey: "",
    priority: 10,
    isActive: true,
    ...body,
  });

beforeEach(() => {
  store.tables = {};
  store.nextId = 1;
  dispatchJob.mockReset();
  asUser(1);
  vi.unstubAllGlobals();
});

describe("print registration authorization", () => {
  it.each([
    ["get", "/api/print/bridge-profiles"],
    ["post", "/api/print/bridge-profiles"],
    ["post", "/api/print/bridge-profiles/1/probe"],
    ["get", "/api/print/printers"],
    ["post", "/api/print/printers"],
    ["post", "/api/print/printers/1/test"],
    ["patch", "/api/print/printers/1"],
    ["patch", "/api/print/settings"],
  ] as const)("rejects non-admins on %s %s", async (method, path) => {
    asUser(1, "csr");
    const res = await api[method](path).send({});
    expect(res.status).toBe(403);
    expect(store.tables.printBridgeProfilesTable ?? []).toHaveLength(0);
    expect(store.tables.printPrintersTable ?? []).toHaveLength(0);
  });
});

describe("bridge profile registration", () => {
  it("creates a general bridge owned by the caller's tenant without echoing credentials", async () => {
    const res = await createBridge({ tenantId: 2 });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("apiKey");
    const [row] = store.tables.printBridgeProfilesTable;
    expect(row).toMatchObject({ tenantId: 1, locationId: null, routingScope: "general", apiKey: "", isActive: true, priority: 10 });
    expect(store.tables.auditLogsTable[0]).toMatchObject({ tenantId: 1, action: "PRINT_BRIDGE_CREATED" });
  });

  it.each(["ftp://100.104.253.117:3100", "not a url", "javascript:alert(1)"])("rejects bridgeUrl %s", async (bridgeUrl) => {
    const res = await createBridge({ bridgeUrl });
    expect(res.status).toBe(400);
    expect(store.tables.printBridgeProfilesTable ?? []).toHaveLength(0);
  });

  it("lists only the caller's tenant bridges and never returns url or key", async () => {
    await createBridge();
    asUser(2);
    await createBridge({ name: "Other tenant bridge" });
    const res = await api.get("/api/print/bridge-profiles");
    expect(res.body.map((b: Row) => b.name)).toEqual(["Other tenant bridge"]);
    expect(res.body[0]).not.toHaveProperty("apiKey");
    expect(res.body[0]).not.toHaveProperty("bridgeUrl");
  });

  it("probes the tenant bridge /health with the central key when the profile key is empty", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { body: bridge } = await createBridge();
    const res = await api.post(`/api/print/bridge-profiles/${bridge.id}/probe`);
    expect(res.body).toMatchObject({ ok: true, httpStatus: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://100.104.253.117:3100/health",
      expect.objectContaining({ headers: { "x-api-key": "central-key" } }),
    );
  });

  it("stores a per-bridge key without ever echoing it, and probes with that key", async () => {
    const PI_KEY = "pi-bridge-key-0123456789abcdef0123456789abcdef";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await createBridge({ name: "Raspberry Pi", bridgeUrl: "http://100.64.0.9:3100", apiKey: PI_KEY, priority: 20 });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(PI_KEY);
    expect(store.tables.printBridgeProfilesTable[0]).toMatchObject({ apiKey: PI_KEY, priority: 20, routingScope: "general" });
    const list = await api.get("/api/print/bridge-profiles");
    expect(JSON.stringify(list.body)).not.toContain(PI_KEY);
    await api.post(`/api/print/bridge-profiles/${res.body.id}/probe`);
    expect(fetchMock).toHaveBeenCalledWith("http://100.64.0.9:3100/health", expect.objectContaining({ headers: { "x-api-key": PI_KEY } }));
  });

  it.each(["short", "has space 0123456789abcdef0123456789abcdef", "line\nbreak0123456789abcdef0123456789abcdef", 12345])(
    "rejects an invalid bridge key %j on create", async (apiKey) => {
      const res = await createBridge({ apiKey });
      expect(res.status).toBe(400);
      expect(store.tables.printBridgeProfilesTable ?? []).toHaveLength(0);
    });

  it("validates key updates and never echoes the key from PATCH", async () => {
    const { body: bridge } = await createBridge();
    const NEW_KEY = "rotated-bridge-key-0123456789abcdef0123456789";
    const bad = await api.patch(`/api/print/bridge-profiles/${bridge.id}`).send({ apiKey: "short" });
    expect(bad.status).toBe(400);
    const ok = await api.patch(`/api/print/bridge-profiles/${bridge.id}`).send({ apiKey: NEW_KEY });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(NEW_KEY);
    expect(store.tables.printBridgeProfilesTable[0].apiKey).toBe(NEW_KEY);
  });

  it("refuses to probe another tenant's bridge", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { body: bridge } = await createBridge();
    asUser(2);
    const res = await api.post(`/api/print/bridge-profiles/${bridge.id}/probe`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("printer registration", () => {
  const printerBody = (bridgeProfileId: unknown, extra: Row = {}) => ({
    name: "Brightek POS80",
    role: "receipt",
    connectionType: "bridge",
    bridgeProfileId,
    bridgePrinterName: "Brightek_POS80",
    locationId: null,
    paperWidth: "80mm",
    copies: 1,
    isActive: true,
    ...extra,
  });

  it("creates a general receipt printer on the tenant's bridge without echoing credentials", async () => {
    const { body: bridge } = await createBridge();
    const res = await api.post("/api/print/printers").send(printerBody(bridge.id, { tenantId: 2 }));
    expect(res.status).toBe(201);
    expect(res.body.printer).not.toHaveProperty("apiKey");
    expect(store.tables.printPrintersTable[0]).toMatchObject({
      tenantId: 1, locationId: null, routingScope: "general", role: "receipt",
      bridgeProfileId: bridge.id, bridgePrinterName: "Brightek_POS80", isActive: true, copies: 1,
    });
  });

  it("rejects a bridge that belongs to another tenant", async () => {
    const { body: bridge } = await createBridge();
    asUser(2);
    const res = await api.post("/api/print/printers").send(printerBody(bridge.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Active bridge profile not found in this tenant");
    expect(store.tables.printPrintersTable ?? []).toHaveLength(0);
  });

  it.each(["../etc/passwd", "-Pdefault", "a;rm", ""])("rejects invalid queue name %j", async (queue) => {
    const { body: bridge } = await createBridge();
    const res = await api.post("/api/print/printers").send(printerBody(bridge.id, { bridgePrinterName: queue }));
    expect(res.status).toBe(400);
    expect(store.tables.printPrintersTable ?? []).toHaveLength(0);
  });

  it("registers a label printer as role=label with its explicit queue and no invented dimensions", async () => {
    const { body: bridge } = await createBridge();
    const res = await api.post("/api/print/printers").send({
      name: "PL70e-BT Label Printer",
      role: "label",
      connectionType: "bridge",
      bridgeProfileId: bridge.id,
      bridgePrinterName: "Label_Themal_Printer",
      copies: 1,
      isActive: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.printer).not.toHaveProperty("apiKey");
    expect(store.tables.printPrintersTable[0]).toMatchObject({
      tenantId: 1, locationId: null, routingScope: "general", role: "label", connectionType: "bridge",
      bridgeProfileId: bridge.id, bridgePrinterName: "Label_Themal_Printer", copies: 1, isActive: true,
    });
    expect(store.tables.auditLogsTable.at(-1)).toMatchObject({ action: "PRINT_PRINTER_CREATED", metadata: { role: "label" } });
  });

  it("deactivates and reactivates a tenant printer through PATCH without deleting it", async () => {
    const { body: bridge } = await createBridge();
    const { body } = await api.post("/api/print/printers").send(printerBody(bridge.id));
    const id = body.printer.id;
    const off = await api.patch(`/api/print/printers/${id}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.printer.isActive).toBe(false);
    expect(store.tables.printPrintersTable).toHaveLength(1);
    expect(store.tables.auditLogsTable.at(-1)).toMatchObject({ action: "PRINT_PRINTER_UPDATED", metadata: { fields: ["isActive"] } });
    const on = await api.patch(`/api/print/printers/${id}`).send({ isActive: true });
    expect(on.body.printer.isActive).toBe(true);
    expect(store.tables.printPrintersTable[0]).toMatchObject({ id, isActive: true, role: "receipt", bridgePrinterName: "Brightek_POS80" });
  });

  it("refuses to change another tenant's printer state", async () => {
    const { body: bridge } = await createBridge();
    const { body } = await api.post("/api/print/printers").send(printerBody(bridge.id));
    asUser(2);
    const res = await api.patch(`/api/print/printers/${body.printer.id}`).send({ isActive: false });
    expect(res.status).toBe(404);
    expect(store.tables.printPrintersTable[0].isActive).toBe(true);
  });

  it("lists only the caller's tenant printers", async () => {
    const { body: bridge } = await createBridge();
    await api.post("/api/print/printers").send(printerBody(bridge.id));
    asUser(2);
    const res = await api.get("/api/print/printers");
    expect(res.body.printers).toEqual([]);
  });
});

describe("controlled printer test", () => {
  it("refuses another tenant's printer and extra body fields before dispatch", async () => {
    const { body: bridge } = await createBridge();
    const { body } = await api.post("/api/print/printers").send({
      name: "Brightek POS80", role: "receipt", connectionType: "bridge",
      bridgeProfileId: bridge.id, bridgePrinterName: "Brightek_POS80",
    });
    const extra = await api.post(`/api/print/printers/${body.printer.id}/test`).send({ testId: "t1", queue: "x" });
    expect(extra.status).toBe(400);
    asUser(2);
    const cross = await api.post(`/api/print/printers/${body.printer.id}/test`).send({ testId: "t1" });
    expect(cross.status).toBe(404);
    expect(dispatchJob).not.toHaveBeenCalled();
    expect(store.tables.printJobsTable ?? []).toHaveLength(0);
  });
});

