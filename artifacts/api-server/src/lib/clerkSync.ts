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
