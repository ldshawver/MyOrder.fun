import { db, tenantsTable } from "@workspace/db";
import { asc } from "drizzle-orm";
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

  const [existing] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .orderBy(asc(tenantsTable.id))
    .limit(1);

  if (existing) {
    _cachedId = existing.id;
    return existing.id;
  }

  // No tenant — seed the default house tenant. Idempotent via slug uniqueness.
  logger.info({ event: "tenant_auto_seed" }, "No tenant row found; seeding default house tenant");
  const [seeded] = await db
    .insert(tenantsTable)
    .values({
      name: "Lucifer Cruz",
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
    .orderBy(asc(tenantsTable.id))
    .limit(1);
  if (!after) throw new Error("Failed to auto-seed house tenant");
  _cachedId = after.id;
  return after.id;
}

/** Test-only: clear the cached tenant id between tests. */
export function _resetHouseTenantCache(): void {
  _cachedId = null;
}
