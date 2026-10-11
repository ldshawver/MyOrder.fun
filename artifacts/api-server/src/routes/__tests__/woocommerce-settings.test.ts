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
import { fetchWooSafely } from "../../lib/wooSafeHttp";

const syncJobMocks = vi.hoisted(() => ({ enqueue: vi.fn(), get: vi.fn(), actorRole: "admin" }));

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
    wcWebhookSecret: "wcWebhookSecret",
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
      onConflictDoNothing: () => {
        if (!state.row) state.row = { id: nextId++, tenantId: vals.tenantId, wcStoreUrl: "", wcConsumerKey: null, wcConsumerSecret: null, wcWebhookSecret: null, wcEnabled: true };
        return { returning: () => Promise.resolve([state.row]) };
      },
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
          wcStoreUrl: "",
          wcConsumerKey: null,
          wcConsumerSecret: null,
          wcWebhookSecret: null,
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

  const db = { execute: vi.fn(() => Promise.resolve()), select, insert, update, transaction: vi.fn() };
  db.transaction.mockImplementation((callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  return { db, adminSettingsTable, tenantsTable, catalogItemsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...values) => ({ values })),
  asc: vi.fn(() => ({})),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/wooSafeHttp", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/wooSafeHttp")>()),
  fetchWooSafely: vi.fn(),
}));

// Bypass auth/role middleware
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => {
    req.dbUser = { id: 1, role: syncJobMocks.actorRole, status: "approved", tenantId: 1 };
    next();
  },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn(async () => 1),
}));

vi.mock("../../lib/wooSyncJobs", () => ({
  enqueueWooSync: syncJobMocks.enqueue,
  getTenantWooSyncJob: syncJobMocks.get,
}));

import settingsRouter from "../settings";
import woocommerceRouter, { pickWooCategory } from "../woocommerce";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", settingsRouter);
  app.use("/api", woocommerceRouter);
  return app;
}

describe("woocommerce settings save/load/sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchWooSafely).mockClear();
    state.row = null;
    nextId = 1;
    syncJobMocks.actorRole = "admin";
    syncJobMocks.enqueue.mockReset();
    syncJobMocks.get.mockReset();
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
    expect(putRes.status, JSON.stringify(putRes.body)).toBe(200);
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

  it("allows updating a tenant store URL while retaining its encrypted credentials", async () => {
    const app = makeApp();
    await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://first.example", wcConsumerKey: "ck_kept", wcConsumerSecret: "cs_kept" });
    const priorKey = state.row?.wcConsumerKey;
    const priorSecret = state.row?.wcConsumerSecret;

    const updated = await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.lucifercruz.com/", enabled: true });
    expect(updated.status).toBe(200);
    expect(updated.body.wcStoreUrl).toBe("https://shop.lucifercruz.com");
    expect(state.row?.wcConsumerKey).toBe(priorKey);
    expect(state.row?.wcConsumerSecret).toBe(priorSecret);
    expect(JSON.stringify(updated.body)).not.toContain("ck_kept");
    expect(JSON.stringify(updated.body)).not.toContain("cs_kept");
  });

  it("uses the most specific Woo category generically, including Apparel & Accessories", () => {
    expect(pickWooCategory([{ name: "Clothing" }, { name: "Apparel & Accessories" }])).toBe("Apparel & Accessories");
    expect(pickWooCategory([{ name: "Books" }, { name: "Fantasy" }])).toBe("Fantasy");
    expect(pickWooCategory([])).toBe("Uncategorized");
  });

  it("stores the Woo webhook signing secret encrypted and returns only a configured flag", async () => {
    const app = makeApp();
    const response = await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.example", wcConsumerKey: "ck_safe", wcConsumerSecret: "cs_safe", wcWebhookSecret: "webhook-secret-value" });
    expect(response.status).toBe(200);
    expect(state.row?.wcWebhookSecret).not.toBe("webhook-secret-value");
    expect(JSON.stringify(response.body)).not.toContain("webhook-secret-value");
    expect(response.body.wcWebhookSecretSet).toBe(true);
    const loaded = await supertest(app).get("/api/admin/settings/woocommerce");
    expect(loaded.body.hasWebhookSecret).toBe(true);
    expect(JSON.stringify(loaded.body)).not.toContain("webhook-secret-value");
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

  it("does not substitute a generic or environment Woo URL when tenant configuration is empty", async () => {
    const app = makeApp();
    const settings = await supertest(app).get("/api/admin/settings/woocommerce");
    expect(settings.body.wcStoreUrl).toBe("");
    await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcConsumerKey: "ck_saved", wcConsumerSecret: "cs_saved" });
    const testConnection = await supertest(app).post("/api/admin/woocommerce/test").send({});
    expect(testConnection.status).toBe(412);
    expect(vi.mocked(fetchWooSafely)).not.toHaveBeenCalled();
  });

  it("rejects unknown configuration fields without persisting or echoing them", async () => {
    const response = await supertest(makeApp()).put("/api/admin/settings/woocommerce")
      .send({ wcConsumerKey: "ck_test", wcConsumerSecret: "cs_test", unexpected: 2 });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("cs_test");
    expect(state.row).toBeNull();
  });

  it("rejects cross-tenant configuration selection before credential storage", async () => {
    const response = await supertest(makeApp()).put("/api/admin/settings/woocommerce?tenantId=2")
      .send({ wcConsumerKey: "ck_test", wcConsumerSecret: "cs_test" });
    expect(response.status).toBe(403);
    expect(state.row).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("cs_test");
  });

  it("test-connection success path (mocked fetch)", async () => {
    const app = makeApp();
    await supertest(app)
      .put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_x", wcConsumerSecret: "cs_x" });

    const fetchSpy = vi.mocked(fetchWooSafely).mockResolvedValue(
      new Response(JSON.stringify({ environment: { version: "8.5.0" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await supertest(app).post("/api/admin/woocommerce/test").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wcVersion).toBe("8.5.0");
    expect(fetchSpy).toHaveBeenCalledWith("https://shop.test", "/wp-json/wc/v3/system_status", "ck_x", "cs_x");
  });

  it("test-connection failure path (mocked fetch returns 401)", async () => {
    const app = makeApp();
    await supertest(app)
      .put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_bad", wcConsumerSecret: "cs_bad" });

    vi.mocked(fetchWooSafely).mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const res = await supertest(app).post("/api/admin/woocommerce/test").send({});
    // Credential rejection is distinguishable from an unavailable upstream.
    expect(res.status).toBe(424);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.ok).toBe(false);
    expect(res.body.upstreamStatus).toBe(401);
    expect(res.body.code).toBe("woocommerce_auth_failed");
    expect(typeof res.body.message).toBe("string");
  });

  it("durably enqueues a tenant sync and returns HTTP 202 with a job identifier", async () => {
    const app = makeApp();
    await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_saved", wcConsumerSecret: "cs_saved" });
    syncJobMocks.enqueue.mockResolvedValue({ id: "e125c5c4-3c1e-46bc-9f57-ff2d56434512", reused: false });

    const response = await supertest(app).post("/api/admin/woocommerce/sync").send({});
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ jobId: "e125c5c4-3c1e-46bc-9f57-ff2d56434512", state: "queued", reused: false });
    expect(syncJobMocks.enqueue).toHaveBeenCalledWith(1, 1);
    expect(vi.mocked(fetchWooSafely)).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("ck_saved");
    expect(JSON.stringify(response.body)).not.toContain("cs_saved");
  });

  it("requires tenant-admin permission and retrieves job state only through the tenant-scoped lookup", async () => {
    const app = makeApp();
    await supertest(app).put("/api/admin/settings/woocommerce")
      .send({ wcStoreUrl: "https://shop.test", wcConsumerKey: "ck_saved", wcConsumerSecret: "cs_saved" });
    syncJobMocks.actorRole = "user";
    const forbidden = await supertest(app).post("/api/admin/woocommerce/sync").send({});
    expect(forbidden.status).toBe(403);
    expect(syncJobMocks.enqueue).not.toHaveBeenCalled();

    syncJobMocks.actorRole = "admin";
    syncJobMocks.get.mockResolvedValue({ id: "e125c5c4-3c1e-46bc-9f57-ff2d56434512", state: "running", processedParents: 12, totalParents: 245 });
    const status = await supertest(app).get("/api/admin/woocommerce/sync/jobs/e125c5c4-3c1e-46bc-9f57-ff2d56434512");
    expect(status.status).toBe(200);
    expect(status.body.job).toMatchObject({ state: "running", processedParents: 12, totalParents: 245 });
    expect(syncJobMocks.get).toHaveBeenCalledWith(1, "e125c5c4-3c1e-46bc-9f57-ff2d56434512");

    syncJobMocks.get.mockResolvedValue(null);
    const otherTenant = await supertest(app).get("/api/admin/woocommerce/sync/jobs/e125c5c4-3c1e-46bc-9f57-ff2d56434512");
    expect(otherTenant.status).toBe(404);
  });
});
