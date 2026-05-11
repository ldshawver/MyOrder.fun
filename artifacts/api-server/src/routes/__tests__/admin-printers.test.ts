/**
 * Tests for /api/admin/printers/* (Task #9).
 *
 * Covers the settings GET/PATCH round-trip with a stubbed db, plus the
 * test-receipt route mocking spawn (local CUPS) and fetch (bridge) so we
 * verify both modes always return JSON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { EventEmitter } from "node:events";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "user-clerk-id" })),
}));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => {
    req.dbUser = { id: 1, role: "admin", status: "approved" };
    next();
  },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Stub spawn — the test-receipt route ultimately calls spawn("lp", ...).
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// In-memory print_settings row.
const state: { row: Record<string, unknown> | null } = { row: null };

vi.mock("@workspace/db", () => {
  const printSettingsTable = { id: "id" };
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(state.row ? [state.row] : []));
    return chain;
  });
  const insert = vi.fn(() => ({
    values: (vals: Record<string, unknown>) => ({
      returning: () => {
        state.row = {
          id: 1,
          autoPrintReceipts: false,
          receiptEnabled: true,
          receiptMethod: "local_cups",
          receiptPrinterName: "receipt",
          labelEnabled: true,
          labelMethod: "local_cups",
          labelPrinterName: "label",
          lastTestResult: null,
          ...vals,
        };
        return Promise.resolve([state.row]);
      },
    }),
  }));
  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => ({
      where: () => ({
        returning: () => {
          state.row = { ...(state.row ?? {}), ...vals };
          return Promise.resolve([state.row]);
        },
      }),
    }),
  }));
  return { db: { select, insert, update }, printSettingsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import adminPrintersRouter from "../admin-printers";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", adminPrintersRouter);
  return app;
}

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (b: Buffer) => void; end: () => void; on: (e: string, fn: () => void) => void };
}
function makeFakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = { write: () => {}, end: () => {}, on: () => {} };
  return p;
}

beforeEach(() => {
  state.row = null;
  spawnMock.mockReset();
  delete process.env.PRINT_BRIDGE_URL;
  delete process.env.PRINT_BRIDGE_API_KEY;
  vi.restoreAllMocks();
});

describe("/api/admin/printers/settings round-trip", () => {
  it("GET seeds defaults, PATCH updates, and a follow-up GET reflects the change", async () => {
    const app = makeApp();

    // First GET creates the row with defaults.
    const get1 = await supertest(app).get("/api/admin/printers/settings");
    expect(get1.status).toBe(200);
    expect(get1.body.ok).toBe(true);
    expect(get1.body.settings.receiptEnabled).toBe(true);
    expect(get1.body.settings.receiptMethod).toBe("local_cups");
    expect(get1.body.settings.receiptPrinterName).toBe("receipt");
    expect(get1.body.settings.labelPrinterName).toBe("label");
    expect(get1.body.settings.autoPrintReceipts).toBe(false);
    expect(get1.body.settings.bridgeUrl).toMatch(/^http:\/\//);

    // PATCH every one of the eight editable fields.
    const patch = await supertest(app)
      .patch("/api/admin/printers/settings")
      .send({
        receiptEnabled: true,
        receiptMethod: "bridge",
        receiptPrinterName: "Reciept_POS80_Printer",
        labelEnabled: false,
        labelMethod: "local_cups",
        labelPrinterName: "Label_Themal_Printer",
        autoPrintReceipts: true,
      });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.settings.receiptMethod).toBe("bridge");
    expect(patch.body.settings.labelEnabled).toBe(false);
    expect(patch.body.settings.autoPrintReceipts).toBe(true);

    // A second GET returns the updated values.
    const get2 = await supertest(app).get("/api/admin/printers/settings");
    expect(get2.body.settings.receiptPrinterName).toBe("Reciept_POS80_Printer");
    expect(get2.body.settings.labelPrinterName).toBe("Label_Themal_Printer");
    expect(get2.body.settings.labelMethod).toBe("local_cups");
  });

  it("PATCH with an invalid method or queue name returns a 400 JSON error", async () => {
    const app = makeApp();
    const r = await supertest(app)
      .patch("/api/admin/printers/settings")
      .send({ receiptMethod: "carrier_pigeon", labelPrinterName: "bad name; rm -rf /" });
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.ok).toBe(false);
    expect(Array.isArray(r.body.errors)).toBe(true);
  });
});

describe("/api/admin/printers/test-receipt", () => {
  it("uses local_cups by default, runs lp -d <queue>, and returns command/stdout/stderr/exitCode", async () => {
    const app = makeApp();
    await supertest(app).get("/api/admin/printers/settings"); // seed

    spawnMock.mockImplementationOnce(() => {
      const proc = makeFakeProc();
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("request id is receipt-7 (1 file(s))\n"));
        proc.emit("close", 0);
      });
      return proc;
    });

    const r = await supertest(app).post("/api/admin/printers/test-receipt").send({});
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.ok).toBe(true);
    expect(r.body.mode).toBe("local_cups");
    expect(r.body.command).toBe("lp -d receipt");
    expect(r.body.exitCode).toBe(0);
    expect(r.body.stdout).toContain("request id is receipt-7");
    expect(spawnMock).toHaveBeenCalledWith("lp", ["-d", "receipt"], expect.any(Object));
  });

  it("returns a friendly JSON error when the bridge is unreachable (mode=bridge)", async () => {
    const app = makeApp();
    await supertest(app).get("/api/admin/printers/settings");
    await supertest(app)
      .patch("/api/admin/printers/settings")
      .send({ receiptMethod: "bridge" });

    // Health check times out (AbortError).
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const r = await supertest(app).post("/api/admin/printers/test-receipt").send({});
    expect(r.status).toBe(502);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.ok).toBe(false);
    expect(r.body.mode).toBe("bridge");
    expect(r.body.message).toContain("Bridge unreachable");
    expect(r.body.message).toMatch(/Local VPS CUPS|Tailscale/);
  });
});
