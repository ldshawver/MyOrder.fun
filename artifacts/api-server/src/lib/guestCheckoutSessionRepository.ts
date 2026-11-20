import { and, eq, isNull, sql } from "drizzle-orm";
import { db, guestCheckoutSessionsTable } from "@workspace/db";

/** The caller owns this transaction; capability consumption never commits it. */
type GuestCheckoutTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ConsumeGuestCheckoutCapabilityInput = {
  sessionId: number;
  tenantId: number;
  actorId: number;
  capabilityDigest: string;
};

export type ConsumeGuestCheckoutCapabilityResult =
  | { available: true; sessionId: number; tenantId: number; guestIdentityId: number; staffActorUserId: number }
  | { available: false };

/**
 * Atomically marks a checkout capability consumed.  This deliberately uses
 * database time and a caller-owned transaction so a later order failure rolls
 * the consumed_at update back with the rest of the checkout transaction.
 */
export async function consumeGuestCheckoutCapability(
  tx: GuestCheckoutTransaction,
  input: ConsumeGuestCheckoutCapabilityInput,
): Promise<ConsumeGuestCheckoutCapabilityResult> {
  const rows = await tx.update(guestCheckoutSessionsTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(guestCheckoutSessionsTable.id, input.sessionId),
      eq(guestCheckoutSessionsTable.tenantId, input.tenantId),
      eq(guestCheckoutSessionsTable.staffActorUserId, input.actorId),
      eq(guestCheckoutSessionsTable.capabilityHash, input.capabilityDigest),
      isNull(guestCheckoutSessionsTable.consumedAt),
      isNull(guestCheckoutSessionsTable.revokedAt),
      sql`${guestCheckoutSessionsTable.expiresAt} > CURRENT_TIMESTAMP`,
    ))
    .returning({
      sessionId: guestCheckoutSessionsTable.id,
      tenantId: guestCheckoutSessionsTable.tenantId,
      guestIdentityId: guestCheckoutSessionsTable.guestIdentityId,
      staffActorUserId: guestCheckoutSessionsTable.staffActorUserId,
    });
  const row = rows[0];
  return row ? { available: true, ...row } : { available: false };
}
