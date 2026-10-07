import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { safeDecrypt } from "../lib/crypto";
import { assertWooHttpsOrigin } from "../lib/wooSafeHttp";
import { logger } from "../lib/logger";
import { reconcileWooWebhookProduct } from "./woocommerce";

const router = Router();
const MAX_BODY_BYTES = 1024 * 1024;
const SUPPORTED_TOPICS = new Set(["product.created", "product.updated", "product.deleted"]);

type WooTenantSecret = { tenantId: number; storeUrl: string; secretCiphertext: string | null };
type EventRow = { id: string; status: "processing" | "processed" | "failed"; payload_sha256: string };

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : null;
}

export function verifyWooWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!rawBody.length || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const receivedBytes = Buffer.from(signature, "base64");
  const expectedBytes = Buffer.from(expected, "base64");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function rows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return ((value as { rows?: T[] } | null)?.rows ?? []);
}

function reject(res: Response, code: string, status: number): void {
  // Log only a fixed classification. Never log headers, URL, body, or secrets.
  logger.warn({ code }, "WooCommerce webhook rejected");
  res.status(status).json({ error: "WooCommerce webhook could not be accepted", code });
}

router.post("/webhooks/woocommerce", async (req, res): Promise<void> => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > MAX_BODY_BYTES) {
    reject(res, "raw_body_invalid", 400);
    return;
  }
  const signature = header(req, "x-wc-webhook-signature");
  const source = header(req, "x-wc-webhook-source");
  const deliveryId = header(req, "x-wc-webhook-delivery-id");
  const topic = header(req, "x-wc-webhook-topic");
  if (!signature || !source || !deliveryId || !topic || deliveryId.length > 200 || topic.length > 100) {
    reject(res, "required_headers_missing_or_invalid", 400);
    return;
  }

  let sourceOrigin: string;
  try { sourceOrigin = assertWooHttpsOrigin(source).origin; }
  catch { reject(res, "source_invalid", 400); return; }

  try {
    const configured = rows<WooTenantSecret>(await db.execute(sql`SELECT tenant_id AS "tenantId", wc_store_url AS "storeUrl", wc_webhook_secret AS "secretCiphertext"
      FROM admin_settings WHERE wc_store_url = ${sourceOrigin} AND wc_webhook_secret IS NOT NULL`));
    const matches: WooTenantSecret[] = [];
    for (const candidate of configured) {
      const secret = safeDecrypt(candidate.secretCiphertext);
      if (secret && verifyWooWebhookSignature(req.body, signature, secret)) matches.push(candidate);
    }
    if (matches.length !== 1) { reject(res, matches.length ? "tenant_configuration_ambiguous" : configured.length ? "signature_invalid" : "tenant_configuration_missing", 401); return; }

    let event: unknown;
    try { event = JSON.parse(req.body.toString("utf8")); }
    catch { reject(res, "signed_body_invalid_json", 400); return; }
    const eventData = event && typeof event === "object" ? event as { id?: unknown; parent_id?: unknown } : null;
    const productId = String(eventData?.id ?? "");
    const parentWooProductId = eventData?.parent_id == null ? undefined : String(eventData.parent_id);
    if (!/^[1-9][0-9]{0,19}$/.test(productId)) { reject(res, "product_identity_invalid", 400); return; }
    if (parentWooProductId !== undefined && !/^[1-9][0-9]{0,19}$/.test(parentWooProductId)) { reject(res, "parent_product_identity_invalid", 400); return; }
    if (!SUPPORTED_TOPICS.has(topic)) {
      // The sender may have unrelated webhook topics enabled. A validly signed
      // event is acknowledged without attempting an unsupported mutation.
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const payloadHash = createHash("sha256").update(req.body).digest("hex");
    const tenantId = matches[0]!.tenantId;
    const claimed = rows<EventRow>(await db.execute(sql`INSERT INTO woocommerce_webhook_events
      (tenant_id, delivery_id, topic, product_id, payload_sha256, status, attempt_count, updated_at)
      VALUES (${tenantId}, ${deliveryId}, ${topic}, ${productId}, ${payloadHash}, 'processing', 1, now())
      ON CONFLICT (tenant_id, delivery_id) DO UPDATE SET status = 'processing', attempt_count = woocommerce_webhook_events.attempt_count + 1,
        error_code = NULL, updated_at = now()
      WHERE woocommerce_webhook_events.payload_sha256 = EXCLUDED.payload_sha256
        AND (woocommerce_webhook_events.status = 'failed' OR
          (woocommerce_webhook_events.status = 'processing' AND woocommerce_webhook_events.updated_at < now() - interval '5 minutes'))
      RETURNING id, status, payload_sha256`));

    if (claimed.length === 0) {
      const existing = rows<EventRow>(await db.execute(sql`SELECT id, status, payload_sha256 FROM woocommerce_webhook_events
        WHERE tenant_id = ${tenantId} AND delivery_id = ${deliveryId} LIMIT 1`))[0];
      if (!existing) { reject(res, "event_claim_failed", 503); return; }
      if (existing.payload_sha256 !== payloadHash) { reject(res, "delivery_id_payload_mismatch", 409); return; }
      if (existing.status === "processed") { res.status(200).json({ ok: true, duplicate: true }); return; }
      // An active processor owns this event. Ask WooCommerce to retry later.
      res.status(503).json({ error: "WooCommerce event is already being processed", code: "event_processing" });
      return;
    }

    try {
      await reconcileWooWebhookProduct(tenantId, productId, topic, parentWooProductId);
      await db.execute(sql`UPDATE woocommerce_webhook_events SET status = 'processed', error_code = NULL,
        processed_at = now(), updated_at = now() WHERE tenant_id = ${tenantId} AND delivery_id = ${deliveryId} AND payload_sha256 = ${payloadHash}`);
      res.status(200).json({ ok: true });
    } catch {
      await db.execute(sql`UPDATE woocommerce_webhook_events SET status = 'failed', error_code = 'reconciliation_failed',
        updated_at = now() WHERE tenant_id = ${tenantId} AND delivery_id = ${deliveryId} AND payload_sha256 = ${payloadHash}`);
      logger.error({ code: "reconciliation_failed", tenantId }, "WooCommerce webhook reconciliation failed");
      res.status(503).json({ error: "WooCommerce product reconciliation failed", code: "reconciliation_failed" });
    }
  } catch {
    reject(res, "event_persistence_failed", 503);
  }
});

export default router;
