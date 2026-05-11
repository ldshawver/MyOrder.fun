/**
 * Tests for the WooCommerce settings save/load/sync flow:
 *  - PUT /api/admin/settings/woocommerce persists creds (encrypted) and round-trips
 *  - GET /api/admin/settings/woocommerce returns secrets MASKED, never plaintext
 *  - POST /api/admin/woocommerce/test success and failure paths (fetch mocked)
 *  - POST /api/admin/woocommerce/test returns 412 JSON when creds are missing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

process.env.SETTINGS_ENC_KEY = "0".repeat(64);

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "user-clerk-id" })),
  clerkClient: { users: { updateUser: vi.fn(), getUser: vi.fn(async () => ({ publicMetadata: {} })) } },
}));

// In-memory single-row settings store
const state: { row: Record<string, unknown> | null } = { row: null };
let nextId = 1;

vi.mock("@workspace/db", () => {
  const adminSettingsTable: Record<string, string> & { _: { name: string } } = {
    id: "id",
    tenantId: "tenantId",
    wcStoreUrl: "wcStoreUrl",
    wcConsumerKey: "wcConsumerKey",
    wcConsumerSecret: "wcConsumerSecret",
    wcEnabled: "wcEnabled",
    _: { name: "admin_settings" },
  };
  const tenantsTable = { id: "id" };
  const catalogItemsTable = { id: "id", alavontId: "alavontId" };

  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve(state.row ? [state.row] : []));
    chain.limit = vi.fn(() => Promise.resolve(state.row ? [state.row] : []));
    return chain;
  });

  const insert = vi.fn(() => ({
    values: (vals: Record<string, unknown>) => ({
      returning: () => {
        state.row = {
          id: nextId++,
          tenantId: 1,
          menuImportEnabled: true,
          showOutOfStock: false,
          enabledProcessors: ["stripe"],
          checkoutConversionPreview: false,
          merchantImageEnabled: true,
          autoPrintOnPayment: false,
          receiptTemplateStyle: "standard",
          labelTemplateStyle: "standard",
          purgeMode: "delayed",
          purgeDelayHours: 72,
          keepAuditToken: true,
          keepFailedPaymentLogs: true,
          receiptLineNameMode: "lucifer_only",
          wcStoreUrl: "https://lucifercruz.com",
          wcConsumerKey: null,
          wcConsumerSecret: null,
          wcEnabled: true,
          updatedAt: new Date(),
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
          state.row = { ...(state.row ?? {}), ...vals, updatedAt: new Date() };
          return Promise.resolve([state.row]);
        },
      }),
    }),
  }));

  const db = { select, insert, update };
  return { db, adminSettingsTable, tenantsTable, catalogItemsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  asc: vi.fn(() => ({})),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Bypass auth/role middleware
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

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn(async () => 1),
}));

import settingsRouter from "../settings";
import woocommerceRouter from "../woocommerce";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", settingsRouter);
  app.use("/api", woocommerceRouter);
  return app;
}

describe("woocommerce settings save/load/sync", () => {
  beforeEach(() => {
    state.row = null;
    nextId = 1;
    vi.restoreAllMocks();
  });

  it("PUT then GET round-trips, secrets are MASKED on read", async () => {
    const app = makeApp();
    const putRes = await supertest(app)
      .put("/api/admin/settings/woocommerce")
      .send({
        wcStoreUrl: "https://example.com",
        wcConsumerKey: "ck_supersecret_key",
        wcConsumerSecret: "cs_supersecret_secret",
        enabled: true,
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.wcStoreUrl).toBe("https://example.com");
    expect(putRes.body.wcConsumerKeySet).toBe(true);
    expect(putRes.body.wcConsumerSecretSet).toBe(true);
    // The plaintext secret must NEVER be returned in any response field.
    expect(JSON.stringify(putRes.body)).not.toContain("ck_supersecret_key");
    expect(JSON.stringify(putRes.body)).not.toContain("cs_supersecret_secret");

    // What's stored in the DB row should be ciphertext, not the plaintext.
    expect(state.row?.wcConsumerKey).toBeTruthy();
    expect(state.row?.wcConsumerKey).not.toBe("ck_supersecret_key");
    expect(String(state.row?.wcConsumerKey).startsWith("enc:v1:")).toBe(true);

    const getRes = await supertest(app).get("/api/admin/settings/woocommerce");
    expect(getRes.status).toBe(200);
    expect(getRes.body.wc_store_url).toBe("https://example.com");
    expect(getRes.body.wcStoreUrl).toBe("https://example.com");
    expect(getRes.body.hasConsumerKey).toBe(true);
    expect(getRes.body.hasConsumerSecret).toBe(true);
    expect(getRes.body.enabled).toBe(true);
    expect(JSON.stringify(getRes.body)).not.toContain("ck_supersecret_key");
    expect(JSON.stringify(getRes.body)).not.toContain("cs_supersecret_secret");
  });

  it("test-connection returns 412 JSON when no creds are saved", async () => {
    const app = makeApp();
    const res = await supertest(app)
      .post("/api/admin/woocommerce/test")
      .send({});
    expect(res.status).toBe(412);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(412);
    expect(typeof res.body.message).toBe("string");
  });

  it("test-connection success path (mocked fetch)", async () => {
    const app = makeApp();
    await supertest(app)
      .put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_x", wcConsumerSecret: "cs_x" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ environment: { version: "8.5.0" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await supertest(app).post("/api/admin/woocommerce/test").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wcVersion).toBe("8.5.0");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://shop.test/wp-json/wc/v3/system_status",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }) }),
    );
  });

  it("test-connection failure path (mocked fetch returns 401)", async () => {
    const app = makeApp();
    await supertest(app)
      .put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_bad", wcConsumerSecret: "cs_bad" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const res = await supertest(app).post("/api/admin/woocommerce/test").send({});
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(401);
    expect(typeof res.body.message).toBe("string");
  });
});
