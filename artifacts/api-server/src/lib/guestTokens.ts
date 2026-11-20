import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type GuestTokenPurpose = "checkout" | "tracking";
const BYTES = 32;
const ENCODED = 43; // base64url encoding of 32 bytes, without padding

function digestInput(purpose: GuestTokenPurpose, token: string) { return `${purpose}:${token}`; }

export function createGuestToken(purpose: GuestTokenPurpose): { token: string; digest: string } {
  const token = randomBytes(BYTES).toString("base64url");
  return { token, digest: hashGuestToken(purpose, token) };
}

export function hashGuestToken(purpose: GuestTokenPurpose, token: string): string {
  if (!isValidGuestToken(token)) throw new GuestTokenError("invalid_token");
  return createHash("sha256").update(digestInput(purpose, token), "utf8").digest("hex");
}

export function isValidGuestToken(value: unknown): value is string {
  return typeof value === "string" && value.length === ENCODED && /^[A-Za-z0-9_-]+$/.test(value);
}

/** Compare SHA-256 hex values without falling back to a variable-time string comparison. */
export function guestTokenDigestMatches(purpose: GuestTokenPurpose, token: unknown, expectedDigest: string): boolean {
  if (!isValidGuestToken(token) || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  const actual = Buffer.from(hashGuestToken(purpose, token), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class GuestTokenError extends Error {
  constructor(readonly code: "invalid_token" | "expired" | "revoked" | "consumed") { super("Guest capability is unavailable"); }
}

export function assertGuestCapabilityState(input: { expiresAt: Date; revokedAt: Date | null; consumedAt?: Date | null }, now = new Date()): void {
  if (input.revokedAt) throw new GuestTokenError("revoked");
  if (input.expiresAt.getTime() <= now.getTime()) throw new GuestTokenError("expired");
  if (input.consumedAt) throw new GuestTokenError("consumed");
}
