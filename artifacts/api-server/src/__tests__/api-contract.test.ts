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

// Bypass the auth middleware chain so unknown /api/* paths actually reach
// the global JSON 404 handler instead of being short-circuited at 401. The
// production behaviour of those middlewares (returning JSON 401) is covered
// by approval-gate.test.ts; this suite is specifically about the contract
// of the global 404 / error / body-parse handlers in app.ts.
vi.mock("../lib/auth", () => {
  const noop = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    requireAuth: noop,
    loadDbUser: noop,
    requireDbUser: noop,
    requireApproved: noop,
    requireRole: () => noop,
  };
});

import supertest from "supertest";
import app from "../app";

describe("API contract — /api/* always returns JSON (real assembled app)", () => {
  it("unknown /api/* path that bypasses auth gates → JSON 404 with documented {error, path}", async () => {
    // /api/__contract/known-prefix is mounted (test-only) with no sub-routes,
    // so this URL falls straight through to the /api JSON 404 handler.
    const target = "/api/__contract/known-prefix/does-not-exist";
    const res = await supertest(app).get(target);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "Not found",
      path: target,
    });
  });

  it("any unknown /api/* path → JSON 404 with documented body shape", async () => {
    const target = "/api/this-route-does-not-exist";
    const res = await supertest(app).get(target);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ error: "Not found", path: target });
  });

  it("malformed JSON body → JSON 400, never HTML", async () => {
    const res = await supertest(app)
      .post("/api/__contract/sync-throw")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("Invalid JSON body");
  });
});

describe("API contract — global error middleware (real assembled app)", () => {
  it("synchronous throw → JSON 500 via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/sync-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("sync boom");
  });

  it("asynchronous throw → JSON 500 via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/async-throw");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("async boom");
  });

  it("error with custom status → that status, JSON body, via the real chain", async () => {
    const res = await supertest(app).get("/api/__contract/custom-status");
    expect(res.status).toBe(418);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("teapot");
  });
});
