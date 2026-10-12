import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const fixtureEnvironment = process.env.MYORDER_ENV;
if (fixtureEnvironment !== "dev" && fixtureEnvironment !== "staging") {
  throw new Error("Acceptance fixtures require MYORDER_ENV=dev or staging");
}
const fixtureSkuPrefix = fixtureEnvironment === "staging" ? "STG" : "DEV";
const tenantId = Number(process.argv.find(arg => arg.startsWith("--tenant-id="))?.split("=")[1]);
if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("Pass --tenant-id=<authorized tenant id>");

function rows<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : ((value as { rows?: T[] } | undefined)?.rows ?? []); }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function createCatalogRow(tx: Transaction, name: string, category: string, price: string, sku: string, unit: string) {
  const catalog = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO catalog_items (tenant_id, name, category, price, sku, merchant_brand,
      customer_safe_name, customer_safe_description, display_category,
      alavont_name, lucifer_cruz_name, merchant_name, stock_unit)
    VALUES (${tenantId}, ${name}, ${category}, ${price}, ${sku}, 'lucifer_cruz',
      ${name}, ${name}, ${category}, ${name}, ${name}, ${name}, ${unit}) RETURNING id
  `))[0];
  const auto = rows<{ optionId: number; productId: number; inventoryItemId: number }>(await tx.execute(sql`
    SELECT id AS "optionId", product_id AS "productId", inventory_item_id AS "inventoryItemId"
    FROM catalogue_options WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalog.id}
  `))[0];
  return { catalogItemId: catalog.id, ...auto };
}

async function addOption(tx: Transaction, productId: number, inventoryItemId: number | null,
  name: string, category: string, price: string, sku: string, unit: string, label: string, consumption: string) {
  const auto = await createCatalogRow(tx, name, category, price, sku, unit);
  await tx.execute(sql`UPDATE catalogue_options SET product_id = ${productId}, label = ${label},
    inventory_item_id = ${inventoryItemId ?? auto.inventoryItemId}, consumption_quantity = ${consumption}
    WHERE tenant_id = ${tenantId} AND id = ${auto.optionId}`);
  if (inventoryItemId != null) await tx.execute(sql`DELETE FROM inventory_items WHERE tenant_id = ${tenantId} AND id = ${auto.inventoryItemId}`);
  await tx.execute(sql`DELETE FROM catalogue_products WHERE tenant_id = ${tenantId} AND id = ${auto.productId}`);
  return { ...auto, inventoryItemId: inventoryItemId ?? auto.inventoryItemId };
}

try {
  await db.transaction(async tx => {
    const tenant = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`))[0];
    if (!tenant) throw new Error("Fixture tenant not found");
    const previous = rows<{ sku: string }>(await tx.execute(sql`
      SELECT sku FROM catalog_items WHERE tenant_id = ${tenantId}
        AND sku IN (${`${fixtureSkuPrefix}-TS-S`}, ${`${fixtureSkuPrefix}-TS-M`}, ${`${fixtureSkuPrefix}-TS-L`},
          ${`${fixtureSkuPrefix}-CB-250`}, ${`${fixtureSkuPrefix}-CB-500`}, ${`${fixtureSkuPrefix}-CB-1000`})
    `));
    if (previous.length) throw new Error("Fixture SKUs already exist; no data was changed");
    let locations = rows<{ id: number }>(await tx.execute(sql`
      SELECT id FROM inventory_locations WHERE tenant_id = ${tenantId} AND is_active = true ORDER BY display_order, id LIMIT 2
    `));
    if (locations.length === 0) throw new Error("Create an inventory location before seeding fixtures");
    if (locations.length === 1) {
      const second = rows<{ id: number }>(await tx.execute(sql`
        INSERT INTO inventory_locations (tenant_id, type, name, display_order)
        VALUES (${tenantId}, 'backstock', ${`${fixtureEnvironment.toUpperCase()} Fixture Backstock`}, 1000) RETURNING id
      `))[0];
      locations = [...locations, second];
    }
    const shirtS = await createCatalogRow(tx, "T-Shirt S", "Apparel", "18.00", `${fixtureSkuPrefix}-TS-S`, "each");
    await tx.execute(sql`UPDATE catalogue_products SET name = 'T-Shirt', inventory_model = 'SEPARATE_VARIANTS',
      location_evaluation = 'PER_LOCATION' WHERE tenant_id = ${tenantId} AND id = ${shirtS.productId}`);
    await tx.execute(sql`UPDATE catalogue_options SET label = 'S' WHERE tenant_id = ${tenantId} AND id = ${shirtS.optionId}`);
    const shirtM = await addOption(tx, shirtS.productId, null, "T-Shirt M", "Apparel", "18.00", `${fixtureSkuPrefix}-TS-M`, "each", "M", "1.000000");
    const shirtL = await addOption(tx, shirtS.productId, null, "T-Shirt L", "Apparel", "18.00", `${fixtureSkuPrefix}-TS-L`, "each", "L", "1.000000");
    const coffee250 = await createCatalogRow(tx, "Coffee Beans 250 g", "Pantry", "8.00", `${fixtureSkuPrefix}-CB-250`, "g");
    await tx.execute(sql`UPDATE catalogue_products SET name = 'Coffee Beans', inventory_model = 'SHARED',
      location_evaluation = 'COMBINED_LOCATIONS' WHERE tenant_id = ${tenantId} AND id = ${coffee250.productId}`);
    await tx.execute(sql`UPDATE inventory_items SET base_unit = 'g' WHERE tenant_id = ${tenantId} AND id = ${coffee250.inventoryItemId}`);
    await tx.execute(sql`UPDATE catalogue_options SET label = '250 g', consumption_quantity = 250.000000
      WHERE tenant_id = ${tenantId} AND id = ${coffee250.optionId}`);
    await addOption(tx, coffee250.productId, coffee250.inventoryItemId, "Coffee Beans 500 g", "Pantry", "15.00", `${fixtureSkuPrefix}-CB-500`, "g", "500 g", "500.000000");
    await addOption(tx, coffee250.productId, coffee250.inventoryItemId, "Coffee Beans 1 kg", "Pantry", "28.00", `${fixtureSkuPrefix}-CB-1000`, "g", "1 kg", "1000.000000");
    for (const fixture of [shirtS, shirtM, shirtL, coffee250]) {
      const initial = fixture === coffee250 ? "3000.000000" : "10.000000";
      await tx.execute(sql`INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand,
        par_level, inventory_kind, is_sellable) VALUES (${tenantId}, ${fixture.catalogItemId}, ${locations[0].id}, ${initial},
        0, 'sellable_catalog', true)`);
      await tx.execute(sql`INSERT INTO inventory_reorder_policies (tenant_id, inventory_item_id, location_id,
        par, reorder_point, preferred_reorder_quantity, moq) VALUES (${tenantId}, ${fixture.inventoryItemId},
        ${locations[0].id}, ${fixture === coffee250 ? "5000.000000" : "12.000000"},
        ${fixture === coffee250 ? "3500.000000" : "5.000000"},
        ${fixture === coffee250 ? "2000.000000" : "12.000000"},
        ${fixture === coffee250 ? "1000.000000" : "6.000000"})`);
      await tx.execute(sql`INSERT INTO inventory_reorder_policies (tenant_id, inventory_item_id, location_id,
        par, reorder_point, preferred_reorder_quantity, moq) VALUES (${tenantId}, ${fixture.inventoryItemId},
        ${locations[1].id}, ${fixture === coffee250 ? "1000.000000" : "3.000000"},
        ${fixture === coffee250 ? "500.000000" : "2.000000"},
        ${fixture === coffee250 ? "1000.000000" : "6.000000"},
        ${fixture === coffee250 ? "500.000000" : "3.000000"})`);
      if (fixture === coffee250) await tx.execute(sql`INSERT INTO inventory_balances (tenant_id, product_id, location_id,
        quantity_on_hand, par_level, inventory_kind, is_sellable) VALUES (${tenantId}, ${fixture.catalogItemId},
        ${locations[1].id}, '2000.000000', 0, 'sellable_catalog', true)`);
      await tx.execute(sql`UPDATE catalog_items SET stock_quantity = (
        SELECT SUM(quantity_on_hand) FROM inventory_balances
        WHERE tenant_id = ${tenantId} AND product_id = ${fixture.catalogItemId}),
        inventory_amount = (SELECT SUM(quantity_on_hand) FROM inventory_balances
        WHERE tenant_id = ${tenantId} AND product_id = ${fixture.catalogItemId})
        WHERE tenant_id = ${tenantId} AND id IN (
          SELECT catalog_item_id FROM catalogue_options WHERE tenant_id = ${tenantId}
          AND inventory_item_id = ${fixture.inventoryItemId})`);
    }
  });
  process.stdout.write(`Created T-Shirt and Coffee Beans fixtures for ${fixtureEnvironment} tenant ${tenantId}\n`);
} finally {
  await pool.end();
}
