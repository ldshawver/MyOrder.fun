/**
 * AES-256-GCM encryption helper for at-rest secrets (e.g. WooCommerce
 * consumer key / secret stored in the admin_settings table).
 *
 * Key source: SETTINGS_ENC_KEY env var. Must be a 32-byte value provided
 * as either a 64-char hex string or a base64 string. If unset on boot we
 * derive a stable key from a fallback (DEPLOY_SHA + a constant salt) and
 * log a warning — this keeps dev environments working but should NEVER be
 * relied on for production secrets.
 *
 * Ciphertext format: base64( iv(12) || tag(16) || ciphertext )
 * Prefixed with "enc:v1:" so callers can distinguish ciphertext from any
 * legacy plaintext that may already exist in the column.
 */
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { logger } from "./logger";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env["SETTINGS_ENC_KEY"];
  if (raw && raw.length > 0) {
    let buf: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
    else {
      try {
        const b = Buffer.from(raw, "base64");
        if (b.length === 32) buf = b;
      } catch { /* fallthrough */ }
    }
    if (!buf) {
      // Derive 32 bytes from arbitrary-length input via scrypt.
      buf = scryptSync(raw, "orderflow-settings-enc-v1", 32);
    }
    cachedKey = buf;
    return cachedKey;
  }
  logger.warn(
    "SETTINGS_ENC_KEY is not set — deriving an ephemeral key. " +
    "Secrets encrypted with this key will NOT decrypt across deploys. " +
    "Set SETTINGS_ENC_KEY to a 32-byte hex/base64 value.",
  );
  const seed = `${process.env["DEPLOY_SHA"] ?? "dev"}::settings-enc-fallback`;
  cachedKey = scryptSync(seed, "orderflow-settings-enc-v1", 32);
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string): string {
  if (!payload.startsWith(PREFIX)) {
    // Legacy plaintext (or a value written before encryption was rolled out).
    return payload;
  }
  const buf = Buffer.from(payload.slice(PREFIX.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Invalid encrypted payload: too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const key = loadKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

export function safeDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch (err) {
    logger.error({ err }, "Failed to decrypt settings secret");
    return null;
  }
}

/** Test-only: reset the cached key so a new SETTINGS_ENC_KEY env value is picked up. */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}
