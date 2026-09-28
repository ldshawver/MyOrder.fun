/**
 * bridgeKey.ts — per-bridge credential rules and the operator path for
 * setting a bridge's key without it ever being displayed.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, auditLogsTable, printBridgeProfilesTable, usersTable } from "@workspace/db";
import { normalizeRole } from "../roles";

/** Empty means "use the central PRINT_BRIDGE_API_KEY"; otherwise a strong, header-safe secret. */
export const BRIDGE_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/;

export function bridgeKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export class BridgeKeyError extends Error {}

/**
 * Sets one bridge profile's key for a tenant. The actor must be an active
 * admin of that tenant (or a global admin); the change is audited with the
 * key's fingerprint only.
 */
export async function setBridgeKey(input: { tenantId: number; bridgeId: number; actorId: number; key: string }): Promise<{ bridgeId: number; tenantId: number; fingerprint: string }> {
  const key = input.key.trim();
  if (!BRIDGE_KEY_PATTERN.test(key)) throw new BridgeKeyError("Key must be 32-256 URL-safe characters");
  const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, input.actorId)).limit(1);
  const role = normalizeRole(actor?.role);
  if (!actor || !actor.isActive || (role !== "global_admin" && (role !== "admin" || actor.tenantId !== input.tenantId))) {
    throw new BridgeKeyError("Actor must be an active admin of this tenant");
  }
  const [bridge] = await db.update(printBridgeProfilesTable).set({ apiKey: key })
    .where(and(eq(printBridgeProfilesTable.tenantId, input.tenantId), eq(printBridgeProfilesTable.id, input.bridgeId)))
    .returning({ id: printBridgeProfilesTable.id });
  if (!bridge) throw new BridgeKeyError("Bridge not found in this tenant");
  const fingerprint = bridgeKeyFingerprint(key);
  await db.insert(auditLogsTable).values({
    tenantId: input.tenantId,
    actorId: actor.id,
    actorEmail: actor.email ?? "",
    actorRole: actor.role,
    action: "PRINT_BRIDGE_KEY_SET",
    resourceType: "print_bridge",
    resourceId: String(bridge.id),
    metadata: { fingerprint, via: "maintenance-set-bridge-key" },
  });
  return { bridgeId: bridge.id, tenantId: input.tenantId, fingerprint };
}
