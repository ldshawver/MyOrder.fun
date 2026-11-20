import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, guestCheckoutSessionsTable, guestOrderIdentitiesTable, labTechShiftsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, normalizeRole, writeAuditLog } from "../lib/auth";
import { requireTenantContext } from "../lib/tenantContext";
import { createGuestToken } from "../lib/guestTokens";

const router: IRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Guest checkout requests rate-limited" } });
const Body = z.object({ displayName: z.string().trim().min(1).max(120), phone: z.string().trim().max(32).optional(), deliveryAddress: z.string().trim().max(500).optional(), idempotencyKey: z.string().trim().min(16).max(200) }).strict();

router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);
function isStaff(role: string) { return ["csr", "supervisor", "admin", "global_admin"].includes(normalizeRole(role)); }
async function authorized(req: Request): Promise<boolean> {
  const actor = req.dbUser!; const tenantId = req.authorizedTenantId!; const role = normalizeRole(actor.role);
  if (!isStaff(role)) return false;
  if (["supervisor", "admin", "global_admin"].includes(role)) return true;
  const [shift] = await db.select({ id: labTechShiftsTable.id }).from(labTechShiftsTable).where(and(
    eq(labTechShiftsTable.tenantId, tenantId),
    eq(labTechShiftsTable.techId, actor.id),
    eq(labTechShiftsTable.status, "active"),
    isNull(labTechShiftsTable.clockedOutAt),
  )).limit(1);
  return Boolean(shift);
}

router.post("/guest-checkout/sessions", limiter, async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: "Invalid guest checkout request" }); return; }
  if (!(await authorized(req))) { res.status(403).json({ error: "Guest checkout requires an authorized active staff session" }); return; }
  const actor = req.dbUser!; const tenantId = req.authorizedTenantId!;
  const fingerprint = createHash("sha256").update(JSON.stringify({ displayName: parsed.data.displayName, phone: parsed.data.phone ?? null, deliveryAddress: parsed.data.deliveryAddress ?? null })).digest("hex");
  const existing = await db.select({ id: guestCheckoutSessionsTable.id, guestIdentityId: guestCheckoutSessionsTable.guestIdentityId, expiresAt: guestCheckoutSessionsTable.expiresAt, requestFingerprint: guestCheckoutSessionsTable.requestFingerprint }).from(guestCheckoutSessionsTable).where(and(eq(guestCheckoutSessionsTable.tenantId, tenantId), eq(guestCheckoutSessionsTable.staffActorUserId, actor.id), eq(guestCheckoutSessionsTable.idempotencyKey, parsed.data.idempotencyKey))).limit(1);
  if (existing[0]) { if (existing[0].requestFingerprint !== fingerprint) { res.status(409).json({ error: "Idempotency key conflicts with a different request" }); return; } res.status(200).json({ sessionId: existing[0].id, guestIdentityId: existing[0].guestIdentityId, expiresAt: existing[0].expiresAt, capabilityIssued: false }); return; }
  const capability = createGuestToken("checkout"); const tracking = createGuestToken("tracking"); const expiresAt = new Date(Date.now() + 15 * 60_000);
  let result: { identityId: number; sessionId: number };
  try { result = await db.transaction(async tx => {
    const [identity] = await tx.insert(guestOrderIdentitiesTable).values({ tenantId, createdByUserId: actor.id, displayName: parsed.data.displayName, phone: parsed.data.phone, deliveryAddress: parsed.data.deliveryAddress, trackingTokenHash: tracking.digest, trackingExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) }).returning({ id: guestOrderIdentitiesTable.id });
    const inserted = await tx.insert(guestCheckoutSessionsTable).values({ tenantId, guestIdentityId: identity!.id, staffActorUserId: actor.id, capabilityHash: capability.digest, expiresAt, idempotencyKey: parsed.data.idempotencyKey, requestFingerprint: fingerprint }).onConflictDoNothing().returning({ id: guestCheckoutSessionsTable.id });
    const session = inserted[0];
    // Throwing aborts the transaction, including the just-created identity.
    if (!session) throw new Error("guest_checkout_idempotency_race");
    return { identityId: identity!.id, sessionId: session!.id };
  }); } catch (error) {
    if (!(error instanceof Error) || error.message !== "guest_checkout_idempotency_race") throw error;
    const winner = await db.select({ id: guestCheckoutSessionsTable.id, guestIdentityId: guestCheckoutSessionsTable.guestIdentityId, expiresAt: guestCheckoutSessionsTable.expiresAt, requestFingerprint: guestCheckoutSessionsTable.requestFingerprint }).from(guestCheckoutSessionsTable).where(and(eq(guestCheckoutSessionsTable.tenantId, tenantId), eq(guestCheckoutSessionsTable.staffActorUserId, actor.id), eq(guestCheckoutSessionsTable.idempotencyKey, parsed.data.idempotencyKey))).limit(1);
    if (!winner[0]) throw error;
    if (winner[0].requestFingerprint !== fingerprint) { res.status(409).json({ error: "Idempotency key conflicts with a different request" }); return; }
    res.status(200).json({ sessionId: winner[0].id, guestIdentityId: winner[0].guestIdentityId, expiresAt: winner[0].expiresAt, capabilityIssued: false }); return;
  }
  await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, tenantId, action: "GUEST_CHECKOUT_SESSION_CREATED", resourceType: "guest_checkout_session", resourceId: String(result.sessionId), metadata: { guestIdentityId: result.identityId }, ipAddress: req.ip });
  // The checkout capability is returned once to the authorized staff session.
  // Tracking delivery is a later explicit handoff flow; never bundle it here.
  res.status(201).json({ sessionId: result.sessionId, guestIdentityId: result.identityId, expiresAt, capability: capability.token });
});
export default router;
