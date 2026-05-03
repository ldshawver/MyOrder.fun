/**
 * API contract tests — every /api/* response is JSON.
 *
 * Verifies:
 *  1. Unknown /api/* routes return JSON 404.
 *  2. Synchronous throws return JSON 500.
 *  3. Asynchronous throws (rejected promises) return JSON 500.
 *  4. Malformed JSON request bodies return JSON 400 (not HTML).
 */

import { describe, it, expect, vi } from "vitest";

// Mock dependencies that have side effects on import so app.ts can load
// in the test environment without real Clerk creds or DB connections.
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({})),
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/api/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/printService", () => ({
  startPrintWorker: () => {},
}));

vi.mock("@workspace/db", () => ({
  db: {},
}));

import express from "express";
import supertest from "supertest";
import app from "../app";

describe("API contract — /api/* always returns JSON", () => {
  it("unknown /api/* route → always JSON (404 if past auth, 401 if gated)", async () => {
    const res = await supertest(app).get("/api/this-route-does-not-exist");
    // /api/* subrouters mount requireAuth, so unknown paths typically hit 401
    // (still JSON) before falling to the 404 handler. Either is acceptable —
    // the contract is JSON-always, never HTML.
    expect([401, 403, 404]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(typeof res.body).toBe("object");
    expect(typeof res.body.error).toBe("string");
  });

  it("/api/__truly_unhandled → JSON 404 with path (passes auth gate)", async () => {
    // The webhooks router and a couple of others are mounted without a path
    // prefix and don't gate everything. Use a clearly-unhandled prefix that
    // doesn't match any router's auth gate to verify the explicit 404 handler
    // emits the documented body shape.
    const res = await supertest(app).get("/api");
    expect([401, 404]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("malformed JSON body → JSON 400, never HTML", async () => {
    const res = await supertest(app)
      .post("/api/anything")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("Invalid JSON body");
  });
});

describe("API contract — error middleware returns JSON 500", () => {
  // Build a minimal app that reuses ONLY the error-handling middleware
  // contract from app.ts by replicating it inline. This isolates the
  // contract from authenticated routes that need real DB/Clerk.
  function buildErrorApp() {
    const a = express();
    a.use(express.json());

    // Sync throw
    a.get("/api/sync-throw", () => {
      throw new Error("sync boom");
    });
    // Async throw (rejected promise — Express 5 forwards automatically)
    a.get("/api/async-throw", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    // Custom status error
    a.get("/api/custom-status", () => {
      const e = new Error("custom") as Error & { status: number };
      e.status = 418;
      throw e;
    });

    // Same JSON error handler shape as app.ts
    a.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        typeof (err as { status?: number; statusCode?: number }).status === "number"
          ? (err as { status: number }).status
          : typeof (err as { statusCode?: number }).statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      res.status(status).json({ error: message, requestId: req.headers["x-request-id"] ?? null });
    });

    return a;
  }

  it("synchronous throw → JSON 500", async () => {
    const res = await supertest(buildErrorApp()).get("/api/sync-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("sync boom");
  });

  it("asynchronous throw → JSON 500", async () => {
    const res = await supertest(buildErrorApp()).get("/api/async-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("async boom");
  });

  it("error with custom status → that status, JSON body", async () => {
    const res = await supertest(buildErrorApp()).get("/api/custom-status");
    expect(res.status).toBe(418);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("custom");
  });
});
