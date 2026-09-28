import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

let _cachedId: number | null = null;

/**
 * Returns the single global tenant ID for this deployment.
 *
 * This product is a single-tenant deployment. We auto-seed a default tenant
 * row the first time we need one (e.g. on a fresh DB, or after a partial
 * restore that imported products but not the tenants table). The cached id
 * is reused for the lifetime of the process.
 */
export async function getHouseTenantId(): Promise<number> {
  if (_cachedId !== null) return _cachedId;
  const configuredId = Number(process.env.MYORDER_SIGNUP_TENANT_ID);
  if (Number.isSafeInteger(configuredId) && configuredId > 0) {
    const [configured] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.id, configuredId)).limit(1);
    if (!configured) throw new Error("Configured signup tenant does not exist");
    _cachedId = configured.id;
    return configured.id;
  }

  // Preserve a genuine one-tenant deployment, but refuse to choose among tenants.
  const candidates = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(2);
  if (candidates.length > 1) throw new Error("Explicit signup tenant configuration is required");
  if (candidates.length === 1) { _cachedId = candidates[0].id; return candidates[0].id; }
  // Empty deployment — seed the default house tenant. Idempotent via slug uniqueness.
  logger.info({ event: "tenant_auto_seed" }, "No tenant row found; seeding default house tenant");
  const [seeded] = await db
    .insert(tenantsTable)
    .values({
      name: "MyOrder.fun",
      slug: "house",
      status: "active",
      plan: "standard",
    })
    .onConflictDoNothing({ target: tenantsTable.slug })
    .returning({ id: tenantsTable.id });

  if (seeded) {
    _cachedId = seeded.id;
    return seeded.id;
  }

  // Insert was a no-op due to a concurrent insert: re-read.
  const [after] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.slug, "house"))
    .limit(1);
  if (!after) throw new Error("Failed to auto-seed house tenant");
  _cachedId = after.id;
  return after.id;
}

/** Test-only: clear the cached tenant id between tests. */
export function _resetHouseTenantCache(): void {
  _cachedId = null;
}
