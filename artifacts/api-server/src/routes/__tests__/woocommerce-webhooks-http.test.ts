import { createHash, createHmac } from "node:crypto";
import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  dbResults: [] as unknown[],
  reconcileCalls: [] as unknown[][],
  failNextReconcile: false,
}));

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: mockState.dbResults.shift() ?? [] })) },
}));

vi.mock("../woocommerce", () => ({
  reconcileWooWebhookProduct: vi.fn(async (...args: unknown[]) => {
    mockState.reconcileCalls.push(args);
    if (mockState.failNextReconcile) {
      mockState.failNextReconcile = false;
      throw new Error("synthetic reconciliation failure");
    }
  }),
}));

import { db } from "@workspace/db";
import router from "../woocommerce-webhooks";

const ORIGIN = "https://store.example";
const SECRET = "synthetic-woocommerce-signing-secret";
const BODY = Buffer.from('{"id":25,"tenant_id":999,"account_id":"foreign","integration_id":999,"store_id":999}');

function app() {
  const server = express();
  server.use("/api/webhooks/woocommerce", express.raw({ type: "application/json", limit: "1mb" }));
  server.use(express.json({ limit: "2mb" }));
  server.use("/api", router);
  server.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as { status?: number };
    res.status(error.status ?? 500).json({ error: "Request rejected" });
  });
  return server;
}

function signature(body: Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function setDb(results: unknown[][]): void {
  mockState.dbResults = [...results];
}

function configuredTenant() {
  return { tenantId: 41, storeUrl: ORIGIN, secretCiphertext: SECRET };
}

function settingsResult() { return [configuredTenant()]; }
function claimResult() { return [{ id: "1", status: "processing", payload_sha256: createHash("sha256").update(BODY).digest("hex") }]; }

function post(body = BODY, deliveryId = "delivery-1", sig = signature(body), source = ORIGIN) {
  return supertest(app()).post("/api/webhooks/woocommerce")
    .set("Content-Type", "application/json")
    .set("X-WC-Webhook-Signature", sig)
    .set("X-WC-Webhook-Source", source)
    .set("X-WC-Webhook-Delivery-ID", deliveryId)
    .set("X-WC-Webhook-Topic", "product.updated")
    .send(body.toString("utf8"));
}

describe("WooCommerce webhook HTTP authentication and delivery state", () => {
  beforeEach(() => {
    process.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "true";
    mockState.dbResults = [];
    mockState.reconcileCalls = [];
    mockState.failNextReconcile = false;
    vi.mocked(db.execute).mockClear();
  });

  it("fails closed before tenant lookup or reconciliation when staging external integration is disabled", async () => {
    process.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "false";
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("woocommerce_external_integration_disabled");
    expect(vi.mocked(db.execute)).not.toHaveBeenCalled();
    expect(mockState.reconcileCalls).toHaveLength(0);
    process.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "true";
  });

  it("authenticates exact raw bytes, derives tenant from stored configuration, and processes once", async () => {
    setDb([settingsResult(), claimResult(), []]);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(mockState.reconcileCalls).toEqual([[41, "25", "product.updated", undefined]]);
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing signature", "", 400],
    ["malformed signature", "%%%bad%%%", 401],
    ["wrong signature", signature(BODY, "wrong-secret"), 401],
  ])("rejects %s", async (_name, sig, expectedStatus) => {
    setDb([settingsResult()]);
    const response = await post(BODY, "delivery-invalid", sig);
    expect(response.status).toBe(expectedStatus);
    expect(mockState.reconcileCalls).toHaveLength(0);
  });

  it("fails closed when the matching tenant has no decryptable webhook secret", async () => {
    setDb([[{ tenantId: 41, storeUrl: ORIGIN, secretCiphertext: null }]]);
    const response = await post(BODY, "delivery-no-secret");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("signature_invalid");
    expect(mockState.reconcileCalls).toHaveLength(0);
  });

  it("rejects a body or whitespace change after signature creation", async () => {
    const changed = Buffer.from('{"id":25, "tenant_id":999,"account_id":"foreign","integration_id":999,"store_id":999}');
    setDb([settingsResult()]);
    const response = await post(changed, "delivery-modified", signature(BODY));
    expect(response.status).toBe(401);
    expect(mockState.reconcileCalls).toHaveLength(0);
  });

  it("rejects malformed JSON only after verifying its exact raw bytes", async () => {
    const invalidJson = Buffer.from('{"id":25');
    setDb([settingsResult()]);
    const response = await post(invalidJson, "delivery-invalid-json", signature(invalidJson));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("signed_body_invalid_json");
    expect(mockState.reconcileCalls).toHaveLength(0);
  });

  it("rejects oversized requests before signature or business processing", async () => {
    const huge = Buffer.alloc(1024 * 1024 + 1, 0x20);
    const response = await post(huge, "delivery-too-large");
    expect(response.status).toBe(413);
    expect(mockState.reconcileCalls).toHaveLength(0);
    expect(vi.mocked(db.execute)).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate delivery without repeating business effects", async () => {
    const digest = createHash("sha256").update(BODY).digest("hex");
    setDb([
      settingsResult(), claimResult(), [],
      settingsResult(), [], [{ id: "1", status: "processed", payload_sha256: digest }],
    ]);
    expect((await post(BODY, "delivery-duplicate")).status).toBe(200);
    const duplicate = await post(BODY, "delivery-duplicate");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, duplicate: true });
    expect(mockState.reconcileCalls).toHaveLength(1);
  });

  it("returns retryable 503 while a concurrent delivery owns the processing claim", async () => {
    setDb([settingsResult(), [], [{ id: "1", status: "processing", payload_sha256: createHash("sha256").update(BODY).digest("hex") }]]);
    const response = await post(BODY, "delivery-concurrent");
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("event_processing");
    expect(mockState.reconcileCalls).toHaveLength(0);
  });

  it("marks failed processing retryable and succeeds once on the supported retry", async () => {
    setDb([settingsResult(), claimResult(), [], settingsResult(), claimResult(), []]);
    mockState.failNextReconcile = true;
    const failed = await post(BODY, "delivery-retry");
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("reconciliation_failed");
    const retried = await post(BODY, "delivery-retry");
    expect(retried.status).toBe(200);
    expect(mockState.reconcileCalls).toHaveLength(2);
  });

  it("binds tenant selection to stored source origin and secret, not payload identifiers", async () => {
    setDb([settingsResult(), claimResult(), []]);
    const accepted = await post(BODY, "delivery-tenant-binding");
    expect(accepted.status).toBe(200);
    expect(mockState.reconcileCalls[0]?.[0]).toBe(41);

    setDb([[]]);
    const foreignSource = await post(BODY, "delivery-foreign-source", signature(BODY), "https://other.example");
    expect(foreignSource.status).toBe(401);
    expect(mockState.reconcileCalls).toHaveLength(1);
  });
});
