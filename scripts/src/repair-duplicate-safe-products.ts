import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const execute = process.argv.includes("--execute");
const dryRun = process.argv.includes("--dry-run") || !execute;
const confirmArg = process.argv.find(arg => arg.startsWith("--confirm="));
const confirmation = confirmArg?.split("=")[1] ?? null;
const REQUIRED_CONFIRMATION = "MERGE_DUPLICATE_CATALOG_ITEMS";
const tenantArg = process.argv.find(arg => arg.startsWith("--tenant-id="));
const tenantId = tenantArg ? Number(tenantArg.split("=")[1]) : null;

if (tenantArg && (!Number.isInteger(tenantId) || tenantId! <= 0)) throw new Error("--tenant-id must be a positive integer");
if (execute && confirmation !== REQUIRED_CONFIRMATION) {
  throw new Error(`Refusing to execute without --confirm=${REQUIRED_CONFIRMATION}`);
}

function normalizeKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

type CatalogStat = {
  id: number;
  tenantId: number;
  name: string | null;
  sku: string | null;
  merchantSku: string | null;
  alavontId: string | null;
  inventoryRows: number;
  orderItemRefs: number;
  shiftInventoryRefs: number;
  inventoryTemplateRefs: number;
};

type MergePlan = {
  duplicateCatalogItemId: number;
  canonicalCatalogItemId: number;
  duplicateName: string | null;
  canonicalName: string | null;
  tenantId: number;
  reason: string;
  matchedKeys: string[];
  duplicateInventoryRows: number;
  canonicalInventoryRows: number;
  duplicateOrderItemRefs: number;
  canonicalOrderItemRefs: number;
  duplicateShiftInventoryRefs: number;
  duplicateInventoryTemplateRefs: number;
};

type MergeResult = MergePlan & {
  orderItemsRepointed: number;
  shiftInventoryItemsRepointed: number;
  inventoryTemplatesRepointed: number;
  inventoryRowsMoved: number;
  inventoryRowsBlockedByConflict: number;
  orderSnapshotsRewritten: number;
  printPayloadsRewritten: number;
  deletedCatalogRows: number;
};

class UnionFind {
  private parent = new Map<number, number>();
  add(id: number) { if (!this.parent.has(id)) this.parent.set(id, id); }
  find(id: number): number {
    const parent = this.parent.get(id);
    if (parent === undefined) { this.parent.set(id, id); return id; }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(a: number, b: number) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] };
  return maybe.rows ?? [];
}

async function getCatalogStats(): Promise<CatalogStat[]> {
  const result = await db.execute(sql`
    SELECT
      ci.id,
      ci.tenant_id AS "tenantId",
      ci.name,
      ci.sku,
      ci.merchant_sku AS "merchantSku",
      ci.alavont_id AS "alavontId",
      (SELECT count(*)::int FROM inventory_balances ib WHERE ib.tenant_id = ci.tenant_id AND ib.product_id = ci.id) AS "inventoryRows",
      (SELECT count(*)::int FROM order_items oi WHERE oi.catalog_item_id = ci.id) AS "orderItemRefs",
      (SELECT count(*)::int FROM shift_inventory_items sii WHERE sii.catalog_item_id = ci.id) AS "shiftInventoryRefs",
      (SELECT count(*)::int FROM inventory_templates it WHERE it.catalog_item_id = ci.id) AS "inventoryTemplateRefs"
    FROM catalog_items ci
    WHERE (${tenantId}::int IS NULL OR ci.tenant_id = ${tenantId}::int)
  `);
  return rowsFrom<CatalogStat>(result).map(row => ({
    ...row,
    id: Number(row.id),
    tenantId: Number(row.tenantId),
    inventoryRows: Number(row.inventoryRows),
    orderItemRefs: Number(row.orderItemRefs),
    shiftInventoryRefs: Number(row.shiftInventoryRefs),
    inventoryTemplateRefs: Number(row.inventoryTemplateRefs),
  }));
}

function buildMergePlan(rows: CatalogStat[]): MergePlan[] {
  const uf = new UnionFind();
  const keyOwners = new Map<string, number[]>();
  const keysById = new Map<number, Set<string>>();

  for (const row of rows) {
    uf.add(row.id);
    const keys = [
      ["name", normalizeKey(row.name)],
      ["sku", normalizeKey(row.sku)],
      ["merchant_sku", normalizeKey(row.merchantSku)],
      ["alavont_id", normalizeKey(row.alavontId)],
    ].filter(([, key]) => key);
    for (const [type, key] of keys) {
      const compound = `${row.tenantId}:${type}:${key}`;
      keyOwners.set(compound, [...(keyOwners.get(compound) ?? []), row.id]);
      keysById.set(row.id, new Set([...(keysById.get(row.id) ?? []), compound]));
    }
  }

  for (const ids of keyOwners.values()) {
    if (ids.length < 2) continue;
    for (const id of ids.slice(1)) uf.union(ids[0]!, id);
  }

  const groups = new Map<number, CatalogStat[]>();
  for (const row of rows) {
    const root = uf.find(row.id);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }

  const plans: MergePlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = [...group].sort((a, b) =>
      (b.inventoryRows > 0 ? 1 : 0) - (a.inventoryRows > 0 ? 1 : 0)
      || (b.orderItemRefs > 0 ? 1 : 0) - (a.orderItemRefs > 0 ? 1 : 0)
      || a.id - b.id
    )[0]!;
    for (const duplicate of group) {
      if (duplicate.id === canonical.id) continue;
      const duplicateKeys = keysById.get(duplicate.id) ?? new Set<string>();
      const canonicalKeys = keysById.get(canonical.id) ?? new Set<string>();
      const matchedKeys = [...duplicateKeys].filter(key => canonicalKeys.has(key)).map(key => key.replace(/^\d+:/, ""));
      plans.push({
        duplicateCatalogItemId: duplicate.id,
        canonicalCatalogItemId: canonical.id,
        duplicateName: duplicate.name,
        canonicalName: canonical.name,
        tenantId: duplicate.tenantId,
        reason: "same tenant and normalized name, SKU, merchant_sku, or alavont_id; canonical prefers inventory, order refs, lowest id",
        matchedKeys,
        duplicateInventoryRows: duplicate.inventoryRows,
        canonicalInventoryRows: canonical.inventoryRows,
        duplicateOrderItemRefs: duplicate.orderItemRefs,
        canonicalOrderItemRefs: canonical.orderItemRefs,
        duplicateShiftInventoryRefs: duplicate.shiftInventoryRefs,
        duplicateInventoryTemplateRefs: duplicate.inventoryTemplateRefs,
      });
    }
  }
  return plans.sort((a, b) => a.canonicalCatalogItemId - b.canonicalCatalogItemId || a.duplicateCatalogItemId - b.duplicateCatalogItemId);
}

function replaceCatalogIdReferences(value: unknown, duplicateId: number, canonicalId: number): { value: unknown; changed: boolean } {
  const idKeys = new Set(["catalogItemId", "originalCatalogItemId", "catalog_item_id", "original_catalog_item_id", "cart_item_id"]);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const replaced = replaceCatalogIdReferences(item, duplicateId, canonicalId);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return { value: next, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (idKeys.has(key) && child === duplicateId) {
        next[key] = canonicalId;
        changed = true;
        continue;
      }
      const replaced = replaceCatalogIdReferences(child, duplicateId, canonicalId);
      next[key] = replaced.value;
      changed ||= replaced.changed;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

async function rewriteJsonbColumn(tx: typeof db, table: string, idColumn: string, jsonColumn: string, duplicateId: number, canonicalId: number): Promise<number> {
  const selectResult = await tx.execute(sql.raw(`SELECT ${idColumn} AS id, ${jsonColumn} AS payload FROM ${table} WHERE ${jsonColumn}::text LIKE '%${duplicateId}%'`));
  const rows = rowsFrom<{ id: number; payload: unknown }>(selectResult);
  let changed = 0;
  for (const row of rows) {
    const replaced = replaceCatalogIdReferences(row.payload, duplicateId, canonicalId);
    if (!replaced.changed) continue;
    await tx.execute(sql.raw(`UPDATE ${table} SET ${jsonColumn} = '${JSON.stringify(replaced.value).replace(/'/g, "''")}'::jsonb WHERE ${idColumn} = ${Number(row.id)}`));
    changed++;
  }
  return changed;
}

async function executeMerge(plan: MergePlan): Promise<MergeResult> {
  return db.transaction(async tx => {
    const orderItems = rowsFrom<{ count: number }>(await tx.execute(sql`UPDATE order_items SET catalog_item_id = ${plan.canonicalCatalogItemId} WHERE catalog_item_id = ${plan.duplicateCatalogItemId} RETURNING 1 AS count`)).length;
    const shiftItems = rowsFrom<{ count: number }>(await tx.execute(sql`UPDATE shift_inventory_items SET catalog_item_id = ${plan.canonicalCatalogItemId} WHERE catalog_item_id = ${plan.duplicateCatalogItemId} RETURNING 1 AS count`)).length;
    const templates = rowsFrom<{ count: number }>(await tx.execute(sql`UPDATE inventory_templates SET catalog_item_id = ${plan.canonicalCatalogItemId} WHERE catalog_item_id = ${plan.duplicateCatalogItemId} RETURNING 1 AS count`)).length;

    const movedInventoryRows = 0;
    const blockedInventoryRows = rowsFrom<{ count: number }>(await tx.execute(sql`SELECT count(*)::int AS count FROM inventory_balances WHERE product_id = ${plan.duplicateCatalogItemId}`))[0]?.count ?? 0;

    const orderSnapshots = await rewriteJsonbColumn(tx, "orders", "id", "alavont_cart_snapshot", plan.duplicateCatalogItemId, plan.canonicalCatalogItemId)
      + await rewriteJsonbColumn(tx, "orders", "id", "lucifer_checkout_snapshot", plan.duplicateCatalogItemId, plan.canonicalCatalogItemId)
      + await rewriteJsonbColumn(tx, "orders", "id", "checkout_conversion_snapshot", plan.duplicateCatalogItemId, plan.canonicalCatalogItemId);
    const printPayloads = await rewriteJsonbColumn(tx, "print_jobs", "id", "payload_json", plan.duplicateCatalogItemId, plan.canonicalCatalogItemId);

    const deletedRows = rowsFrom<{ id: number }>(await tx.execute(sql`
      DELETE FROM catalog_items ci
      WHERE ci.id = ${plan.duplicateCatalogItemId}
        AND ci.id <> ${plan.canonicalCatalogItemId}
        AND NOT EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.product_id = ci.id)
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.catalog_item_id = ci.id)
      RETURNING ci.id
    `)).length;

    return {
      ...plan,
      orderItemsRepointed: orderItems,
      shiftInventoryItemsRepointed: shiftItems,
      inventoryTemplatesRepointed: templates,
      inventoryRowsMoved: movedInventoryRows,
      inventoryRowsBlockedByConflict: Number(blockedInventoryRows),
      orderSnapshotsRewritten: orderSnapshots,
      printPayloadsRewritten: printPayloads,
      deletedCatalogRows: deletedRows,
    };
  });
}


async function getInventoryQuantityFingerprint(): Promise<string> {
  const row = rowsFrom<{ total: string | null }>(await db.execute(sql`SELECT COALESCE(SUM(quantity_on_hand), 0)::text AS total FROM inventory_balances`))[0];
  return row?.total ?? "0";
}

async function collectPostRepairViolations(): Promise<Record<string, unknown>> {
  const duplicateCatalogRows = rowsFrom<{ count: number }>(await db.execute(sql`
    WITH keys AS (
      SELECT ci.id, ci.tenant_id, 'name' AS key_type, lower(regexp_replace(trim(ci.name), '[^a-zA-Z0-9]+', ' ', 'g')) AS key_value FROM catalog_items ci WHERE nullif(trim(ci.name), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'sku', lower(regexp_replace(trim(ci.sku), '[^a-zA-Z0-9]+', ' ', 'g')) FROM catalog_items ci WHERE nullif(trim(ci.sku), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'merchant_sku', lower(regexp_replace(trim(ci.merchant_sku), '[^a-zA-Z0-9]+', ' ', 'g')) FROM catalog_items ci WHERE nullif(trim(ci.merchant_sku), '') IS NOT NULL
      UNION ALL
      SELECT ci.id, ci.tenant_id, 'alavont_id', lower(regexp_replace(trim(ci.alavont_id), '[^a-zA-Z0-9]+', ' ', 'g')) FROM catalog_items ci WHERE nullif(trim(ci.alavont_id), '') IS NOT NULL
    ), duplicate_keys AS (
      SELECT tenant_id, key_type, key_value FROM keys GROUP BY tenant_id, key_type, key_value HAVING count(*) > 1
    )
    SELECT count(DISTINCT k.id)::int AS count FROM keys k JOIN duplicate_keys dk ON dk.tenant_id = k.tenant_id AND dk.key_type = k.key_type AND dk.key_value = k.key_value
  `))[0]?.count ?? 0;
  const orphanInventoryRows = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM inventory_balances ib LEFT JOIN catalog_items ci ON ci.id = ib.product_id AND ci.tenant_id = ib.tenant_id WHERE ci.id IS NULL`))[0]?.count ?? 0;
  const duplicateInventoryRows = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM (SELECT tenant_id, product_id, location_id FROM inventory_balances GROUP BY tenant_id, product_id, location_id HAVING count(*) > 1) d`))[0]?.count ?? 0;
  const orphanOrderItems = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM order_items oi LEFT JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE ci.id IS NULL`))[0]?.count ?? 0;
  const orphanShiftItems = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM shift_inventory_items sii LEFT JOIN catalog_items ci ON ci.id = sii.catalog_item_id WHERE sii.catalog_item_id IS NOT NULL AND ci.id IS NULL`))[0]?.count ?? 0;
  const orphanTemplates = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM inventory_templates it LEFT JOIN catalog_items ci ON ci.id = it.catalog_item_id WHERE it.catalog_item_id IS NOT NULL AND ci.id IS NULL`))[0]?.count ?? 0;
  return { duplicateCatalogRows, orphanInventoryRows, duplicateInventoryRows, orphanOrderItems, orphanShiftItems, orphanTemplates };
}

function hasPostRepairViolations(violations: Record<string, unknown>): boolean {
  return Object.values(violations).some(value => Number(value) > 0);
}

const stats = await getCatalogStats();
const plans = buildMergePlan(stats);

if (dryRun) {
  console.log(JSON.stringify({
    mode: "dry-run",
    executeCommand: `pnpm --filter @workspace/scripts repair-duplicate-safe-products -- --execute --confirm=${REQUIRED_CONFIRMATION}`,
    duplicatesFound: plans.length,
    mergesPlanned: plans.length,
    deletionsEligibleNow: plans.filter(plan => plan.duplicateInventoryRows === 0 && plan.duplicateOrderItemRefs === 0).length,
    inventoryMoveSummary: {
      rowsOnDuplicateProducts: plans.reduce((sum, plan) => sum + plan.duplicateInventoryRows, 0),
      note: "Execute mode never modifies inventory_balances; duplicates with inventory rows remain blocked for manual review.",
    },
    plans,
  }, null, 2));
  process.exit(0);
}

const inventoryQuantityBefore = await getInventoryQuantityFingerprint();
const results: MergeResult[] = [];
for (const plan of plans) results.push(await executeMerge(plan));
const inventoryQuantityAfter = await getInventoryQuantityFingerprint();
const postRepairViolations = await collectPostRepairViolations();
if (inventoryQuantityBefore !== inventoryQuantityAfter || hasPostRepairViolations(postRepairViolations)) {
  console.error(JSON.stringify({
    mode: "execute",
    error: "Post-repair integrity validation failed",
    inventoryQuantityBefore,
    inventoryQuantityAfter,
    postRepairViolations,
    results,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  mode: "execute",
  duplicatesFound: plans.length,
  mergesPerformed: results.length,
  deletionsPerformed: results.reduce((sum, result) => sum + result.deletedCatalogRows, 0),
  inventoryMovedSummary: {
    rowsMoved: results.reduce((sum, result) => sum + result.inventoryRowsMoved, 0),
    rowsBlockedByConflict: results.reduce((sum, result) => sum + result.inventoryRowsBlockedByConflict, 0),
    quantitiesModified: false,
    inventoryQuantityBefore,
    inventoryQuantityAfter,
  },
  postRepairViolations,
  results,
}, null, 2));
