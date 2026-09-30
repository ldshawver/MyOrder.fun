/** Audited staging-only maintenance through the same service as the admin HTTP route. */
import { and, eq, sql } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";
import { applyCatalogLifecycleTransition } from "../routes/catalog";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}
function positiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Explicit positive tenant, actor and expected-hold IDs are required");
  return parsed;
}
function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : ((result as { rows?: T[] }).rows ?? []);
}

async function main() {
  if (argument("target") !== "staging" && argument("target") !== "clone") throw new Error("Only staging or its disposable clone is supported");
  const target = argument("target");
  const expectedDatabase = target === "staging" ? "myorder_staging" : "myorder_test";
  const tenantId = positiveInteger(argument("tenant-id"));
  const actorId = positiveInteger(argument("actor-id"));
  const expectedHolds = Number(argument("expected-holds"));
  if (!Number.isSafeInteger(expectedHolds) || expectedHolds < 0) throw new Error("An explicit expected hold count is required");
  const apply = process.argv.includes("--apply");
  const actualDatabase = rows<{ name: string }>(await db.execute(sql`SELECT current_database() AS name`))[0]?.name;
  if (actualDatabase !== expectedDatabase) throw new Error(`Target database mismatch: expected ${expectedDatabase}`);
  const [actor] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, actorId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!actor) throw new Error("The explicit actor is not assigned to this tenant");
  const held = rows<{ id: number }>(await db.execute(sql`
    SELECT id FROM catalog_items WHERE tenant_id = ${tenantId}
      AND metadata->>'complianceHold' = 'true' ORDER BY id
  `));
  if (held.length !== expectedHolds) throw new Error(`Hold count changed: expected ${expectedHolds}, found ${held.length}`);
  console.log(JSON.stringify({ target, database: actualDatabase, tenantId, heldBefore: held.length,
    itemIds: held.map(item => item.id), mode: apply ? "apply" : "preview" }));
  if (!apply) return;
  for (const item of held) {
    const changed = await applyCatalogLifecycleTransition({ tenantId, id: item.id, actor,
      change: { complianceHold: false, reason: "Luke-authorized administrative compliance clearance" },
      source: "delegated_maintenance" });
    if (!changed) throw new Error(`Catalogue item ${item.id} disappeared during clearance`);
  }
  const remaining = rows<{ count: number }>(await db.execute(sql`
    SELECT count(*)::int AS count FROM catalog_items WHERE tenant_id = ${tenantId}
      AND metadata->>'complianceHold' = 'true'
  `))[0]?.count;
  if (remaining !== 0) throw new Error(`Compliance clearance incomplete: ${remaining} holds remain`);
  console.log(JSON.stringify({ target, tenantId, cleared: held.length, heldAfter: remaining }));
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
