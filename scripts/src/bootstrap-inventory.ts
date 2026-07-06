import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const tenantArg = process.argv.find(arg => arg.startsWith("--tenant-id="));
const tenantId = tenantArg ? Number(tenantArg.split("=")[1]) : NaN;
if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error("Usage: pnpm --filter @workspace/scripts bootstrap-inventory -- --tenant-id=<tenant_id>");

const REQUIRED_LOCATION_NAMES = ["Backstock", "Storefront", "CSR Sales Box 1", "CSR Sales Box 2"] as const;

type CountRow = { count: number | string };
function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] }).rows ?? [];
}

async function ensureStandardLocationsForTenant(inputTenantId: number): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "csr_boxes" (
    "id" serial PRIMARY KEY,
    "tenant_id" integer NOT NULL,
    "slug" text NOT NULL,
    "label" text NOT NULL,
    "description" text,
    "location" text,
    "is_active" boolean NOT NULL DEFAULT true,
    "display_order" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "inventory_locations" (
    "id" serial PRIMARY KEY,
    "tenant_id" integer NOT NULL,
    "type" text NOT NULL,
    "csr_box_id" integer,
    "name" text NOT NULL,
    "is_active" boolean NOT NULL DEFAULT true,
    "display_order" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "inventory_balances" (
    "id" serial PRIMARY KEY,
    "tenant_id" integer NOT NULL,
    "product_id" integer NOT NULL,
    "location_id" integer NOT NULL,
    "quantity_on_hand" numeric(10, 3) NOT NULL DEFAULT 0,
    "par_level" numeric(10, 2) NOT NULL DEFAULT 0,
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable_catalog'`);
  await db.execute(sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "is_sellable" boolean NOT NULL DEFAULT true`);

  await db.execute(sql`INSERT INTO csr_boxes (tenant_id, slug, label, display_order, is_active)
    SELECT ${inputTenantId}, 'sales-box-1', 'CSR Sales Box 1', 1, true
    WHERE NOT EXISTS (SELECT 1 FROM csr_boxes WHERE tenant_id = ${inputTenantId} AND slug = 'sales-box-1')`);
  await db.execute(sql`INSERT INTO csr_boxes (tenant_id, slug, label, display_order, is_active)
    SELECT ${inputTenantId}, 'sales-box-2', 'CSR Sales Box 2', 2, true
    WHERE NOT EXISTS (SELECT 1 FROM csr_boxes WHERE tenant_id = ${inputTenantId} AND slug = 'sales-box-2')`);
  await db.execute(sql`INSERT INTO inventory_locations (tenant_id, type, name, display_order, is_active)
    SELECT ${inputTenantId}, 'backstock', 'Backstock', 1, true
    WHERE NOT EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${inputTenantId} AND name = 'Backstock')`);
  await db.execute(sql`INSERT INTO inventory_locations (tenant_id, type, name, display_order, is_active)
    SELECT ${inputTenantId}, 'storefront', 'Storefront', 2, true
    WHERE NOT EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${inputTenantId} AND name = 'Storefront')`);
  await db.execute(sql`INSERT INTO inventory_locations (tenant_id, type, csr_box_id, name, display_order, is_active)
    SELECT ${inputTenantId}, 'csr_box', (SELECT id FROM csr_boxes WHERE tenant_id = ${inputTenantId} AND slug = 'sales-box-1' LIMIT 1), 'CSR Sales Box 1', 3, true
    WHERE NOT EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${inputTenantId} AND name = 'CSR Sales Box 1')`);
  await db.execute(sql`INSERT INTO inventory_locations (tenant_id, type, csr_box_id, name, display_order, is_active)
    SELECT ${inputTenantId}, 'csr_box', (SELECT id FROM csr_boxes WHERE tenant_id = ${inputTenantId} AND slug = 'sales-box-2' LIMIT 1), 'CSR Sales Box 2', 4, true
    WHERE NOT EXISTS (SELECT 1 FROM inventory_locations WHERE tenant_id = ${inputTenantId} AND name = 'CSR Sales Box 2')`);
}

export async function ensureAllInventoryRowsExistForTenant(inputTenantId: number) {
  await ensureStandardLocationsForTenant(inputTenantId);
  const totalProductsProcessed = Number(rowsFrom<CountRow>(await db.execute(sql`SELECT count(*)::int AS count FROM catalog_items WHERE tenant_id = ${inputTenantId}`))[0]?.count ?? 0);
  const rowsAlreadyExisting = Number(rowsFrom<CountRow>(await db.execute(sql`
    SELECT count(*)::int AS count
    FROM catalog_items ci
    JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.name = ANY(${[...REQUIRED_LOCATION_NAMES]})
    JOIN inventory_balances ib ON ib.tenant_id = ci.tenant_id AND ib.product_id = ci.id AND ib.location_id = il.id
    WHERE ci.tenant_id = ${inputTenantId}
  `))[0]?.count ?? 0);
  const inventoryAuthorityPath = "../../artifacts/api-server/src/lib/inventoryAuthority";
  const authority = await import(inventoryAuthorityPath) as { bootstrapMissingInventoryBalancesThroughAuthority: (tenantId: number, requiredLocationNames: readonly string[]) => Promise<number> };
  const rowsCreated = await authority.bootstrapMissingInventoryBalancesThroughAuthority(inputTenantId, REQUIRED_LOCATION_NAMES);
  return { tenantId: inputTenantId, rowsCreated, rowsAlreadyExisting, totalProductsProcessed, requiredLocations: [...REQUIRED_LOCATION_NAMES] };
}

console.log(JSON.stringify(await ensureAllInventoryRowsExistForTenant(tenantId), null, 2));
