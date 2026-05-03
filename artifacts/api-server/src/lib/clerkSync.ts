import { clerkClient } from "@clerk/express";
import { logger } from "./logger";

export type ClerkSyncStatus = "pending" | "approved" | "rejected" | "deactivated";

const VALID_CLERK_ROLES = [
  "admin",
  "supervisor",
  "business_sitter",
  "customer_service_rep",
  "sales_rep",
  "lab_tech",
  "user",
] as const;
type ValidClerkRole = typeof VALID_CLERK_ROLES[number];

export interface ClerkSyncPayload {
  status?: ClerkSyncStatus;
  role?: string;
}

/**
 * Push approval state into the Clerk user's publicMetadata so subsequent
 * sign-ins know the user is approved without an extra DB round trip and
 * so the Clerk dashboard reflects the app-level decision.
 *
 * Failures are logged but do not throw — the DB write is the source of
 * truth and the next sync-on-read will reconcile any drift.
 */
export async function syncUserToClerk(
  clerkId: string | null | undefined,
  payload: ClerkSyncPayload,
): Promise<void> {
  if (!clerkId) return;
  try {
    const existing = await clerkClient.users.getUser(clerkId).catch(() => null);
    const currentMeta = (existing?.publicMetadata as Record<string, unknown> | undefined) ?? {};
    const next: Record<string, unknown> = { ...currentMeta };
    if (payload.status !== undefined) next.status = payload.status;
    if (payload.role !== undefined) next.role = payload.role;
    await clerkClient.users.updateUserMetadata(clerkId, { publicMetadata: next });
  } catch (err) {
    logger.error({ err, clerkId, payload }, "Failed to sync user metadata to Clerk");
  }
}

/**
 * Read approval state from a Clerk session's publicMetadata. Different JWT
 * templates expose the metadata under different keys, so we check both
 * `publicMetadata` and the snake_case `public_metadata` form.
 */
/**
 * Mirror name + phone fields to the Clerk user record via clerkClient.users.updateUser.
 *
 * Phone is passed through as `phoneNumber` (Clerk's backend accepts an array
 * of E.164 strings on user update for some configurations; if Clerk rejects
 * the request the DB write is still authoritative and we simply log).
 *
 * Failures are logged but do not throw — the DB write is the source of truth.
 */
export async function syncProfileToClerk(
  clerkId: string | null | undefined,
  payload: {
    firstName?: string | null;
    lastName?: string | null;
    phoneNumber?: string | null;
  },
): Promise<void> {
  if (!clerkId) return;
  const params: Record<string, unknown> = {};
  if (payload.firstName !== undefined) params.firstName = payload.firstName ?? "";
  if (payload.lastName !== undefined) params.lastName = payload.lastName ?? "";
  if (payload.phoneNumber !== undefined) {
    // Clerk expects an array of phone numbers on bulk update; sending an
    // empty array clears existing primary numbers. We send what we have.
    params.phoneNumber = payload.phoneNumber ? [payload.phoneNumber] : [];
  }
  if (Object.keys(params).length === 0) return;
  try {
    // Cast required because Clerk's typed UpdateUserParams varies by version
    // and does not always declare `phoneNumber` directly.
    await clerkClient.users.updateUser(clerkId, params as never);
  } catch (err) {
    logger.error({ err, clerkId, payload }, "Failed to sync profile to Clerk");
  }
}

// Hard limits for avatar fetches to mitigate abuse.
const AVATAR_FETCH_TIMEOUT_MS = 5_000;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const AVATAR_ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * Returns true if the IP literal points at a private/loopback/link-local
 * range that the API server must never be tricked into fetching (SSRF).
 */
function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6: block loopback, unique-local, link-local, and v4-mapped private.
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrReservedIp(mapped[1]);
  return false;
}

/**
 * SSRF-safe URL guard: only http(s), no userinfo/non-default ports
 * outside 80/443, and the resolved host IP must be public.
 */
async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`avatar URL has unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("avatar URL must not contain credentials");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) {
    throw new Error(`avatar URL port not allowed: ${port}`);
  }
  // If the host is already an IP literal, validate it directly. Otherwise
  // resolve every A/AAAA record and reject if any address is private —
  // this prevents DNS rebinding to internal addresses.
  const dns = await import("node:dns/promises");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    addrs = [host];
  } else {
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    addrs = resolved.map((r) => r.address);
    if (addrs.length === 0) throw new Error(`avatar URL did not resolve: ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateOrReservedIp(a)) {
      throw new Error(`avatar URL resolves to a non-public address: ${a}`);
    }
  }
  return url;
}

/**
 * Mirror an avatar URL to Clerk's profile image. Clerk's
 * updateUserProfileImage takes a binary file, so we fetch the URL and
 * forward the bytes — but only after a strict SSRF guard, with hard
 * limits on response size, content-type, and timeout. Failures are
 * logged but never thrown — the DB write already succeeded.
 */
export async function syncAvatarToClerk(
  clerkId: string | null | undefined,
  url: string | null | undefined,
): Promise<void> {
  if (!clerkId || !url) return;
  try {
    const safe = await assertSafePublicUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AVATAR_FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(safe, { redirect: "error", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`avatar fetch failed: HTTP ${resp.status}`);
    const ct = (resp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!AVATAR_ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new Error(`avatar content-type not allowed: ${ct}`);
    }
    const len = Number(resp.headers.get("content-length") ?? "0");
    if (len && len > AVATAR_MAX_BYTES) {
      throw new Error(`avatar too large: ${len} bytes`);
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > AVATAR_MAX_BYTES) {
      throw new Error(`avatar too large after read: ${buf.byteLength} bytes`);
    }
    const blob = new Blob([buf], { type: ct });
    await clerkClient.users.updateUserProfileImage(clerkId, { file: blob } as never);
  } catch (err) {
    logger.error({ err, clerkId, url }, "Failed to sync avatar to Clerk");
  }
}

export function readClerkPublicMetadata(
  sessionClaims: Record<string, unknown> | null | undefined,
): { status?: ClerkSyncStatus; role?: string } {
  if (!sessionClaims) return {};
  const meta =
    (sessionClaims.publicMetadata as Record<string, unknown> | undefined) ??
    (sessionClaims.public_metadata as Record<string, unknown> | undefined) ??
    undefined;
  if (!meta) return {};
  const rawStatus = typeof meta.status === "string" ? meta.status : undefined;
  const status =
    rawStatus === "pending" ||
    rawStatus === "approved" ||
    rawStatus === "rejected" ||
    rawStatus === "deactivated"
      ? (rawStatus as ClerkSyncStatus)
      : undefined;
  const rawRole = typeof meta.role === "string" ? meta.role : undefined;
  const role: ValidClerkRole | undefined =
    rawRole && (VALID_CLERK_ROLES as readonly string[]).includes(rawRole)
      ? (rawRole as ValidClerkRole)
      : undefined;
  return { status, role };
}
