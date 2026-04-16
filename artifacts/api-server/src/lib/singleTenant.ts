import { db, tenantsTable } from "@workspace/db";
import { asc } from "drizzle-orm";

let _cachedId: number | null = null;

/**
 * Returns the single global tenant ID for this deployment.
 * Cached after first call. Throws if no tenants table row exists.
 */
export async function getHouseTenantId(): Promise<number> {
  if (_cachedId !== null) return _cachedId;
  const [t] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .orderBy(asc(tenantsTable.id))
    .limit(1);
  if (!t) throw new Error("No tenant row found — seed a tenant first");
  _cachedId = t.id;
  return t.id;
}
