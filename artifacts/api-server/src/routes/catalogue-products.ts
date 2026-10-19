import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { requireTenantContext } from "../lib/tenantContext";
import { quantityText, quantityUnits } from "../lib/exactQuantity";
import { recommendReplenishment, type LocationPolicyInput } from "../lib/cataloguePolicy";
import { upsertInventoryBalanceThroughAuthority } from "../lib/inventoryAuthority";
import { loadSellableProducts } from "../lib/catalogueSellable";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);
const admin = requireRole("global_admin", "admin", "supervisor");
const id = z.coerce.number().int().positive();
const physical = z.string().refine(value => {
  try { quantityUnits(value); return true; } catch { return false; }
}, "Use a nonnegative decimal with at most six places");
const money = z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/);
const optionValuesInput = z.record(z.string().trim().min(1).max(80), z.string().trim().min(1).max(120))
  .refine(value => Object.keys(value).length <= 8, "A variant may have at most eight option axes");
const productInput = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(120),
  price: money,
  sku: z.string().trim().max(120).nullable().optional(),
  firstOptionLabel: z.string().trim().min(1).max(80).default("Standard"),
  inventoryModel: z.enum(["SHARED", "SEPARATE_VARIANTS"]).default("SEPARATE_VARIANTS"),
  locationEvaluation: z.enum(["PER_LOCATION", "COMBINED_LOCATIONS"]).default("PER_LOCATION"),
  baseUnit: z.string().trim().min(1).max(40).default("each"),
  consumptionQuantity: physical.default("1"),
}).strict();
const optionInput = z.object({
  label: z.string().trim().min(1).max(80),
  optionValues: optionValuesInput.default({}),
  sku: z.string().trim().max(120).nullable().optional(),
  barcode: z.string().trim().max(120).nullable().optional(),
  price: money,
  compareAtPrice: money.nullable().optional(),
  consumptionQuantity: physical,
  inventoryItemId: z.number().int().positive().optional(),
  active: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
}).strict();

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}
type ProductRow = { id: number; tenantId: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; active: boolean };
type OptionRow = { id: number; productId: number; catalogItemId: number; inventoryItemId: number; inventoryCatalogItemId: number; label: string; optionValues: Record<string, string>; consumptionQuantity: string; sku: string | null; barcode: string | null; price: string; compareAtPrice: string | null; baseUnit: string; active: boolean; isAvailable: boolean; complianceHold: boolean; complianceReason: string | null };

type InventoryRelationship = { inventoryItemId: number; catalogItemId: number; inventoryCatalogItemId: number };
function trustedInventoryItem(model: ProductRow["inventoryModel"], options: InventoryRelationship[]): number {
  if (!options.length) throw new Error("A product needs an active inventory-consuming option");
  const identities = options.map(option => option.inventoryItemId);
  const distinct = new Set(identities);
  if (model === "SHARED" && distinct.size !== 1) {
    throw new Error("Shared options must use one inventory item; controlled reconciliation is required");
  }
  if (model === "SEPARATE_VARIANTS" && distinct.size !== identities.length) {
    throw new Error("Separate variants must use independent inventory items; controlled reconciliation is required");
  }
  if (model === "SEPARATE_VARIANTS" && options.some(option => option.inventoryCatalogItemId !== option.catalogItemId)) {
    throw new Error("Each separate variant must use its own catalogue inventory item; controlled reconciliation is required");
  }
  return identities[0];
}

async function productForTenant(executor: typeof db, tenantId: number, productId: number): Promise<ProductRow | undefined> {
  return rows<ProductRow>(await executor.execute(sql`
    SELECT id, tenant_id AS "tenantId", name, inventory_model AS "inventoryModel",
      location_evaluation AS "locationEvaluation", active
    FROM catalogue_products WHERE tenant_id = ${tenantId} AND id = ${productId} LIMIT 1
  `))[0];
}

async function optionForTenant(executor: typeof db, tenantId: number, optionId: number): Promise<OptionRow | undefined> {
  return rows<OptionRow>(await executor.execute(sql`
    SELECT co.id, co.product_id AS "productId", co.catalog_item_id AS "catalogItemId",
      co.inventory_item_id AS "inventoryItemId", ii.catalog_item_id AS "inventoryCatalogItemId",
      co.label, co.option_values AS "optionValues", co.consumption_quantity AS "consumptionQuantity", ci.sku, ci.barcode, ci.price, ci.compare_at_price AS "compareAtPrice",
      ii.base_unit AS "baseUnit", co.active, ci.is_available AS "isAvailable",
      (ci.metadata->>'complianceHold' = 'true') AS "complianceHold",
      ci.metadata->>'complianceReason' AS "complianceReason"
    FROM catalogue_options co
    JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
    JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
    WHERE co.tenant_id = ${tenantId} AND co.id = ${optionId} LIMIT 1
  `))[0];
}

router.get("/catalogue/products", async (req, res): Promise<void> => {
  res.json({ products: await loadSellableProducts(req.authorizedTenantId!) });
});

router.get("/admin/catalogue/products", admin, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  const products = rows<ProductRow>(await db.execute(sql`
    SELECT id, tenant_id AS "tenantId", name, inventory_model AS "inventoryModel",
      location_evaluation AS "locationEvaluation", active
    FROM catalogue_products WHERE tenant_id = ${tenantId} ORDER BY id
  `));
  const options = rows<OptionRow>(await db.execute(sql`
    SELECT co.id, co.product_id AS "productId", co.catalog_item_id AS "catalogItemId",
      co.inventory_item_id AS "inventoryItemId", ii.catalog_item_id AS "inventoryCatalogItemId",
      co.label, co.option_values AS "optionValues", co.consumption_quantity AS "consumptionQuantity", ci.sku, ci.barcode, ci.price, ci.compare_at_price AS "compareAtPrice",
      ii.base_unit AS "baseUnit", co.active, ci.is_available AS "isAvailable",
      (ci.metadata->>'complianceHold' = 'true') AS "complianceHold",
      ci.metadata->>'complianceReason' AS "complianceReason"
    FROM catalogue_options co
    JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
    JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
    WHERE co.tenant_id = ${tenantId} ORDER BY co.product_id, co.sort_order, co.id
  `));
  res.json({ products: products.map(product => ({ ...product, options: options.filter(option => option.productId === product.id) })) });
});

router.post("/admin/catalogue/products", admin, async (req, res): Promise<void> => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const tenantId = req.authorizedTenantId!;
  const body = parsed.data;
  try {
    const created = await db.transaction(async tx => {
      // The catalogue insert trigger creates the safe one-product/Standard-option baseline.
      const catalog = rows<{ id: number }>(await tx.execute(sql`
        INSERT INTO catalog_items (tenant_id, name, category, price, sku, merchant_brand,
          customer_safe_name, customer_safe_description, display_category,
          alavont_name, lucifer_cruz_name, merchant_name, stock_unit)
        VALUES (${tenantId}, ${body.name}, ${body.category}, ${body.price}, ${body.sku ?? null},
          'lucifer_cruz', ${body.name}, ${body.name}, ${body.category}, ${body.name},
          ${body.name}, ${body.name}, ${body.baseUnit}) RETURNING id
      `))[0];
      const auto = rows<{ id: number; productId: number; inventoryItemId: number }>(await tx.execute(sql`
        SELECT id, product_id AS "productId", inventory_item_id AS "inventoryItemId"
        FROM catalogue_options WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalog.id}
      `))[0];
      await tx.execute(sql`UPDATE catalogue_products SET name = ${body.name}, inventory_model = ${body.inventoryModel},
        location_evaluation = ${body.locationEvaluation} WHERE tenant_id = ${tenantId} AND id = ${auto.productId}`);
      await tx.execute(sql`UPDATE catalogue_options SET label = ${body.firstOptionLabel},
        option_values = '{}'::jsonb, consumption_quantity = ${quantityText(quantityUnits(body.consumptionQuantity))}
        WHERE tenant_id = ${tenantId} AND id = ${auto.id}`);
      await tx.execute(sql`UPDATE inventory_items SET base_unit = ${body.baseUnit}
        WHERE tenant_id = ${tenantId} AND id = ${auto.inventoryItemId}`);
      return { productId: auto.productId, optionId: auto.id, catalogItemId: catalog.id, inventoryItemId: auto.inventoryItemId };
    });
    res.status(201).json(created);
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

router.patch("/admin/catalogue/products/:productId", admin, async (req, res): Promise<void> => {
  const parsedId = id.safeParse(req.params.productId);
  const parsed = z.object({ name: z.string().trim().min(1).max(160).optional(),
    inventoryModel: z.enum(["SHARED", "SEPARATE_VARIANTS"]).optional(),
    locationEvaluation: z.enum(["PER_LOCATION", "COMBINED_LOCATIONS"]).optional() }).strict().safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Invalid product update" }); return; }
  const tenantId = req.authorizedTenantId!;
  try {
    const updated = await db.transaction(async tx => {
      const current = rows<ProductRow>(await tx.execute(sql`
        SELECT id, name, inventory_model AS "inventoryModel", location_evaluation AS "locationEvaluation"
        FROM catalogue_products WHERE tenant_id = ${tenantId} AND id = ${parsedId.data} FOR UPDATE
      `))[0];
      if (!current) return null;
      if (parsed.data.inventoryModel && parsed.data.inventoryModel !== current.inventoryModel) {
        const options = rows<InventoryRelationship>(await tx.execute(sql`
          SELECT co.inventory_item_id AS "inventoryItemId", co.catalog_item_id AS "catalogItemId",
            ii.catalog_item_id AS "inventoryCatalogItemId"
          FROM catalogue_options co JOIN inventory_items ii
            ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
          WHERE co.tenant_id = ${tenantId} AND co.product_id = ${current.id} AND co.active = true
          ORDER BY co.id
        `));
        trustedInventoryItem(parsed.data.inventoryModel, options);
      }
      // The database trigger also rejects model transitions with recorded activity.
      await tx.execute(sql`UPDATE catalogue_products SET name = ${parsed.data.name ?? current.name},
        inventory_model = ${parsed.data.inventoryModel ?? current.inventoryModel},
        location_evaluation = ${parsed.data.locationEvaluation ?? current.locationEvaluation}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${current.id}`);
      return current.id;
    });
    if (!updated) { res.status(404).json({ error: "Product not found" }); return; }
    res.json({ product: await productForTenant(db, tenantId, updated) });
  } catch (error) { res.status(409).json({ error: (error as Error).message, code: "CONTROLLED_RECONCILIATION_REQUIRED" }); }
});

router.post("/admin/catalogue/products/:productId/options", admin, async (req, res): Promise<void> => {
  const parsedId = id.safeParse(req.params.productId);
  const parsed = optionInput.safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Invalid option" }); return; }
  const tenantId = req.authorizedTenantId!;
  const body = parsed.data;
  try {
    const result = await db.transaction(async tx => {
      const product = rows<ProductRow>(await tx.execute(sql`SELECT id, name, inventory_model AS "inventoryModel"
        FROM catalogue_products WHERE tenant_id = ${tenantId} AND id = ${parsedId.data} AND active = true FOR UPDATE`))[0];
      if (!product) return null;
      const base = rows<{ category: string; baseUnit: string; inventoryItemId: number }>(await tx.execute(sql`
        SELECT ci.category, ii.base_unit AS "baseUnit", co.inventory_item_id AS "inventoryItemId"
        FROM catalogue_options co JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
        JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
        WHERE co.tenant_id = ${tenantId} AND co.product_id = ${product.id} AND co.active = true
        ORDER BY co.id LIMIT 1
      `))[0];
      if (!base) throw new Error("A product needs an active inventory-consuming option");
      const existingOptions = rows<InventoryRelationship>(await tx.execute(sql`
        SELECT co.inventory_item_id AS "inventoryItemId", co.catalog_item_id AS "catalogItemId",
          ii.catalog_item_id AS "inventoryCatalogItemId"
        FROM catalogue_options co JOIN inventory_items ii
          ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
        WHERE co.tenant_id = ${tenantId} AND co.product_id = ${product.id} AND co.active = true
        ORDER BY co.id
      `));
      const existingValues = rows<{ id: number; label: string; optionValues: Record<string, string> }>(await tx.execute(sql`
        SELECT id, label, option_values AS "optionValues" FROM catalogue_options
        WHERE tenant_id = ${tenantId} AND product_id = ${product.id} AND active = true ORDER BY id
      `));
      const sharedInventoryItemId = trustedInventoryItem(product.inventoryModel, existingOptions);
      const name = `${product.name} ${body.label}`;
      const suppliedValues = Object.fromEntries(Object.entries(body.optionValues).sort(([a], [b]) => a.localeCompare(b)));
      if (Object.keys(suppliedValues).some(key => !key.trim())) throw new Error("Option names cannot be empty");
      const existingAxes = existingValues.find(option => Object.keys(option.optionValues ?? {}).length)?.optionValues;
      let normalizedValues: Record<string, string> = suppliedValues;
      if (Object.keys(suppliedValues).length) {
        if (existingAxes && JSON.stringify(Object.keys(existingAxes).sort()) !== JSON.stringify(Object.keys(suppliedValues).sort())) {
          throw new Error("Every variant in a product must use the same option axes");
        }
      } else {
        if (existingAxes && Object.keys(existingAxes).some(axis => axis !== "Option")) {
          throw new Error("This product uses structured options; provide every required option value");
        }
        const baseline = existingValues.find(option => Object.keys(option.optionValues ?? {}).length === 0);
        if (baseline) {
          const baselineValues = { Option: baseline.label };
          await tx.execute(sql`UPDATE catalogue_options SET option_values = ${JSON.stringify(baselineValues)}::jsonb
            WHERE tenant_id = ${tenantId} AND id = ${baseline.id}`);
        }
        normalizedValues = { Option: body.label };
      }
      const explicitAxes = Object.keys(suppliedValues).some(axis => axis !== "Option");
      if (explicitAxes) {
        await tx.execute(sql`UPDATE catalogue_options SET active = false, updated_at = now()
          WHERE tenant_id = ${tenantId} AND product_id = ${product.id} AND option_values = '{}'::jsonb`);
        await tx.execute(sql`UPDATE catalog_items SET is_available = false, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id IN (SELECT catalog_item_id FROM catalogue_options
            WHERE tenant_id = ${tenantId} AND product_id = ${product.id} AND option_values = '{}'::jsonb)`);
      }
      if (body.sku?.trim()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, 740015)`);
        const duplicate = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM catalog_items
          WHERE tenant_id = ${tenantId} AND lower(btrim(sku)) = lower(${body.sku.trim()}) LIMIT 1`))[0];
        if (duplicate) throw new Error("SKU already exists in this tenant");
      }
      const catalog = rows<{ id: number }>(await tx.execute(sql`
        INSERT INTO catalog_items (tenant_id, name, category, price, compare_at_price, sku, barcode, is_available, merchant_brand,
          customer_safe_name, customer_safe_description, display_category,
          alavont_name, lucifer_cruz_name, merchant_name, stock_unit)
        VALUES (${tenantId}, ${name}, ${base.category}, ${body.price}, ${body.compareAtPrice ?? null}, ${body.sku?.trim() || null}, ${body.barcode?.trim() || null}, ${body.isAvailable ?? true},
          'lucifer_cruz', ${name}, ${name}, ${base.category}, ${name}, ${name}, ${name}, ${base.baseUnit})
        RETURNING id
      `))[0];
      const auto = rows<{ id: number; productId: number; inventoryItemId: number }>(await tx.execute(sql`
        SELECT id, product_id AS "productId", inventory_item_id AS "inventoryItemId"
        FROM catalogue_options WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalog.id}
      `))[0];
      let inventoryItemId = auto.inventoryItemId;
      if (product.inventoryModel === "SHARED") {
        inventoryItemId = sharedInventoryItemId;
        if (body.inventoryItemId !== undefined && body.inventoryItemId !== inventoryItemId) {
          throw new Error("Shared inventory item must already belong to this product");
        }
      } else if (body.inventoryItemId !== undefined && body.inventoryItemId !== auto.inventoryItemId) {
        throw new Error("Separate variants require their own inventory item");
      }
      await tx.execute(sql`UPDATE catalogue_options SET product_id = ${product.id}, label = ${body.label}, option_values = ${JSON.stringify(normalizedValues)}::jsonb,
        active = ${body.active ?? true},
        inventory_item_id = ${inventoryItemId}, consumption_quantity = ${quantityText(quantityUnits(body.consumptionQuantity))},
        updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${auto.id}`);
      if (inventoryItemId !== auto.inventoryItemId) await tx.execute(sql`DELETE FROM inventory_items WHERE tenant_id = ${tenantId} AND id = ${auto.inventoryItemId}`);
      await tx.execute(sql`DELETE FROM catalogue_products WHERE tenant_id = ${tenantId} AND id = ${auto.productId}`);
      return { optionId: auto.id, catalogItemId: catalog.id, inventoryItemId, optionValues: normalizedValues };
    });
    if (!result) { res.status(404).json({ error: "Product not found" }); return; }
    res.status(201).json(result);
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

router.patch("/admin/catalogue/options/:optionId", admin, async (req, res): Promise<void> => {
  const parsedId = id.safeParse(req.params.optionId);
  const parsed = optionInput.partial().safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Invalid option update" }); return; }
  const tenantId = req.authorizedTenantId!;
  const option = await optionForTenant(db, tenantId, parsedId.data);
  if (!option) { res.status(404).json({ error: "Option not found" }); return; }
  if (parsed.data.inventoryItemId !== undefined && parsed.data.inventoryItemId !== option.inventoryItemId) {
    res.status(409).json({ error: "Changing an option inventory identity requires controlled reconciliation" }); return;
  }
  const quantity = parsed.data.consumptionQuantity ?? option.consumptionQuantity;
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM catalogue_products
        WHERE tenant_id = ${tenantId} AND id = ${option.productId} FOR UPDATE`);
      if (parsed.data.optionValues !== undefined) {
        const siblingValues = rows<{ optionValues: Record<string, string> }>(await tx.execute(sql`SELECT option_values AS "optionValues"
          FROM catalogue_options WHERE tenant_id = ${tenantId} AND product_id = ${option.productId}
            AND id <> ${option.id} AND active = true`));
        const siblingAxes = siblingValues.find(candidate => Object.keys(candidate.optionValues ?? {}).length)?.optionValues;
        const nextAxes = Object.keys(parsed.data.optionValues);
        if (siblingAxes && JSON.stringify(Object.keys(siblingAxes).sort()) !== JSON.stringify(nextAxes.sort())) {
          throw new Error("Every variant in a product must use the same option axes");
        }
      }
      if (parsed.data.sku?.trim()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, 740015)`);
        const duplicate = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM catalog_items
          WHERE tenant_id = ${tenantId} AND lower(btrim(sku)) = lower(${parsed.data.sku.trim()}) AND id <> ${option.catalogItemId} LIMIT 1`))[0];
        if (duplicate) throw new Error("SKU already exists in this tenant");
      }
      await tx.execute(sql`UPDATE catalogue_options SET label = ${parsed.data.label ?? option.label},
        option_values = ${parsed.data.optionValues === undefined ? sql`option_values` : sql`${JSON.stringify(Object.fromEntries(Object.entries(parsed.data.optionValues).sort(([a], [b]) => a.localeCompare(b))))}::jsonb`},
        active = ${parsed.data.active ?? option.active}, consumption_quantity = ${quantityText(quantityUnits(quantity))}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${option.id}`);
      await tx.execute(sql`UPDATE catalog_items SET sku = ${parsed.data.sku === undefined ? option.sku : parsed.data.sku},
        barcode = ${parsed.data.barcode === undefined ? option.barcode : parsed.data.barcode},
        compare_at_price = ${parsed.data.compareAtPrice === undefined ? option.compareAtPrice : parsed.data.compareAtPrice},
        is_available = ${parsed.data.isAvailable ?? option.isAvailable}, price = ${parsed.data.price ?? option.price}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${option.catalogItemId}`);
    });
    res.json({ option: await optionForTenant(db, tenantId, option.id) });
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

const policyInput = z.object({ par: physical, reorderPoint: physical,
  preferredReorderQuantity: physical, moq: physical }).strict();
router.patch("/admin/catalogue/inventory/:inventoryItemId", admin, async (req, res): Promise<void> => {
  const parsedId = id.safeParse(req.params.inventoryItemId);
  const parsed = z.object({ baseUnit: z.string().trim().min(1).max(40) }).strict().safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Invalid base unit" }); return; }
  const tenantId = req.authorizedTenantId!;
  try {
    const result = await db.transaction(async tx => {
      const item = rows<{ catalogItemId: number; baseUnit: string }>(await tx.execute(sql`
        SELECT catalog_item_id AS "catalogItemId", base_unit AS "baseUnit"
        FROM inventory_items WHERE tenant_id = ${tenantId} AND id = ${parsedId.data} FOR UPDATE
      `))[0];
      if (!item) return "missing";
      if (item.baseUnit === parsed.data.baseUnit) return "ok";
      const activity = rows<{ active: boolean }>(await tx.execute(sql`
        SELECT (EXISTS (SELECT 1 FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${item.catalogItemId})
          OR EXISTS (SELECT 1 FROM inventory_reservations WHERE catalog_item_id = ${item.catalogItemId})
          OR EXISTS (SELECT 1 FROM inventory_reorder_policies WHERE tenant_id = ${tenantId} AND inventory_item_id = ${parsedId.data})
          OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ${tenantId}
            WHERE oi.inventory_item_id = ${parsedId.data})) AS active
      `))[0];
      if (activity?.active) return "reconciliation";
      await tx.execute(sql`UPDATE inventory_items SET base_unit = ${parsed.data.baseUnit}
        WHERE tenant_id = ${tenantId} AND id = ${parsedId.data}`);
      return "ok";
    });
    if (result === "missing") { res.status(404).json({ error: "Inventory item not found" }); return; }
    if (result === "reconciliation") { res.status(409).json({ error: "Changing a unit with balances or activity requires controlled reconciliation" }); return; }
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});
router.get("/admin/catalogue/inventory/:inventoryItemId/locations", admin, async (req, res): Promise<void> => {
  const parsedId = id.safeParse(req.params.inventoryItemId);
  if (!parsedId.success) { res.status(400).json({ error: "Invalid inventory item" }); return; }
  const tenantId = req.authorizedTenantId!;
  const item = rows<{ id: number; baseUnit: string }>(await db.execute(sql`
    SELECT id, base_unit AS "baseUnit" FROM inventory_items WHERE tenant_id = ${tenantId} AND id = ${parsedId.data}
  `))[0];
  if (!item) { res.status(404).json({ error: "Inventory item not found" }); return; }
  const locations = rows(await db.execute(sql`
    SELECT il.id AS "locationId", il.name, il.is_active AS "eligible",
      COALESCE(b.quantity_on_hand, 0)::text AS "quantityOnHand", COALESCE(p.par, 0)::text AS par,
      COALESCE(p.reorder_point, 0)::text AS "reorderPoint",
      COALESCE(p.preferred_reorder_quantity, 0)::text AS "preferredReorderQuantity",
      COALESCE(p.moq, 0)::text AS moq
    FROM inventory_locations il JOIN inventory_items ii ON ii.tenant_id = il.tenant_id AND ii.id = ${item.id}
    LEFT JOIN inventory_balances b ON b.tenant_id = il.tenant_id AND b.location_id = il.id AND b.product_id = ii.catalog_item_id
      AND b.inventory_kind = 'sellable_catalog' AND b.is_sellable = true AND b.quarantined_at IS NULL
    LEFT JOIN inventory_reorder_policies p ON p.tenant_id = il.tenant_id AND p.location_id = il.id AND p.inventory_item_id = ii.id
    WHERE il.tenant_id = ${tenantId} ORDER BY il.display_order, il.id
  `));
  res.json({ item, locations });
});
router.put("/admin/catalogue/inventory/:inventoryItemId/locations/:locationId/policy", admin, async (req, res): Promise<void> => {
  const itemId = id.safeParse(req.params.inventoryItemId);
  const locationId = id.safeParse(req.params.locationId);
  const parsed = policyInput.safeParse(req.body);
  if (!itemId.success || !locationId.success || !parsed.success) { res.status(400).json({ error: "Invalid reorder policy" }); return; }
  const tenantId = req.authorizedTenantId!;
  const owned = rows<{ itemId: number }>(await db.execute(sql`
    SELECT ii.id AS "itemId" FROM inventory_items ii JOIN inventory_locations il ON il.tenant_id = ii.tenant_id
    WHERE ii.tenant_id = ${tenantId} AND ii.id = ${itemId.data} AND il.id = ${locationId.data}
  `));
  if (!owned.length) { res.status(404).json({ error: "Inventory item or location not found" }); return; }
  const p = parsed.data;
  await db.execute(sql`INSERT INTO inventory_reorder_policies (tenant_id, inventory_item_id, location_id, par,
    reorder_point, preferred_reorder_quantity, moq) VALUES (${tenantId}, ${itemId.data}, ${locationId.data},
    ${quantityText(quantityUnits(p.par))}, ${quantityText(quantityUnits(p.reorderPoint))},
    ${quantityText(quantityUnits(p.preferredReorderQuantity))}, ${quantityText(quantityUnits(p.moq))})
    ON CONFLICT (tenant_id, inventory_item_id, location_id) DO UPDATE SET par = EXCLUDED.par,
    reorder_point = EXCLUDED.reorder_point, preferred_reorder_quantity = EXCLUDED.preferred_reorder_quantity,
    moq = EXCLUDED.moq, updated_at = now()`);
  res.json({ ok: true });
});

router.put("/admin/catalogue/inventory/:inventoryItemId/locations/:locationId/balance", admin, async (req, res): Promise<void> => {
  const itemId = id.safeParse(req.params.inventoryItemId);
  const locationId = id.safeParse(req.params.locationId);
  const parsed = z.object({ quantityOnHand: physical }).strict().safeParse(req.body);
  if (!itemId.success || !locationId.success || !parsed.success) { res.status(400).json({ error: "Invalid balance" }); return; }
  const tenantId = req.authorizedTenantId!;
  const owned = rows<{ catalogItemId: number }>(await db.execute(sql`
    SELECT ii.catalog_item_id AS "catalogItemId" FROM inventory_items ii
    JOIN inventory_locations il ON il.tenant_id = ii.tenant_id
    WHERE ii.tenant_id = ${tenantId} AND ii.id = ${itemId.data} AND il.id = ${locationId.data}
  `))[0];
  if (!owned) { res.status(404).json({ error: "Inventory item or location not found" }); return; }
  const policy = rows<{ par: string }>(await db.execute(sql`SELECT par FROM inventory_reorder_policies
    WHERE tenant_id = ${tenantId} AND inventory_item_id = ${itemId.data} AND location_id = ${locationId.data}`))[0];
  try {
    await db.transaction(async tx => {
      await upsertInventoryBalanceThroughAuthority(tx, { tenantId, productId: owned.catalogItemId,
        locationId: locationId.data, quantityOnHand: quantityText(quantityUnits(parsed.data.quantityOnHand)),
        parLevel: policy?.par ?? "0.000000", context: "catalogueProducts.adjustBalance" });
      await tx.execute(sql`UPDATE catalog_items SET
        stock_quantity = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances
          WHERE tenant_id = ${tenantId} AND product_id = ${owned.catalogItemId}), 0),
        inventory_amount = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances
          WHERE tenant_id = ${tenantId} AND product_id = ${owned.catalogItemId}), 0)
        WHERE tenant_id = ${tenantId} AND id IN (
          SELECT catalog_item_id FROM catalogue_options WHERE tenant_id = ${tenantId}
            AND inventory_item_id = ${itemId.data})`);
    });
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

router.get("/admin/catalogue/recommendations", admin, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  const items = rows<{ inventoryItemId: number; productId: number; productName: string; locationEvaluation: string; baseUnit: string }>(await db.execute(sql`
    SELECT DISTINCT ii.id AS "inventoryItemId", cp.id AS "productId", cp.name AS "productName",
      cp.location_evaluation AS "locationEvaluation", ii.base_unit AS "baseUnit"
    FROM inventory_items ii JOIN catalogue_options co ON co.tenant_id = ii.tenant_id AND co.inventory_item_id = ii.id
    JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
    WHERE ii.tenant_id = ${tenantId} AND cp.active = true ORDER BY "inventoryItemId", "productId"
  `));
  const data = [];
  for (const item of items) {
    const locations = rows<{ locationId: number; name: string; available: string; par: string; reorderPoint: string; preferredReorderQuantity: string; moq: string; eligible: boolean }>(await db.execute(sql`
      SELECT il.id AS "locationId", il.name,
        GREATEST(0, COALESCE(b.quantity_on_hand, 0) - COALESCE((
          SELECT SUM(r.quantity) FROM inventory_reservations r
          JOIN orders o ON o.id = r.order_id AND o.tenant_id = ${tenantId}
          WHERE r.catalog_item_id = ii.catalog_item_id AND r.location_id = il.id AND r.status = 'reserved'
            AND (r.expires_at > now() OR EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.tenant_id = ${tenantId}
              AND pa.order_id = r.order_id AND pa.state IN ('creating','created','approved','capturing','reconciliation_required')))
        ), 0))::text AS available,
        COALESCE(p.par, 0)::text AS par, COALESCE(p.reorder_point, 0)::text AS "reorderPoint",
        COALESCE(p.preferred_reorder_quantity, 0)::text AS "preferredReorderQuantity", COALESCE(p.moq, 0)::text AS moq,
        il.is_active AS eligible
      FROM inventory_locations il
      JOIN inventory_items ii ON ii.tenant_id = il.tenant_id AND ii.id = ${item.inventoryItemId}
      LEFT JOIN inventory_balances b ON b.tenant_id = il.tenant_id AND b.location_id = il.id AND b.product_id = ii.catalog_item_id
        AND b.inventory_kind = 'sellable_catalog' AND b.is_sellable = true AND b.quarantined_at IS NULL
      LEFT JOIN inventory_reorder_policies p ON p.tenant_id = il.tenant_id AND p.location_id = il.id AND p.inventory_item_id = ii.id
      WHERE il.tenant_id = ${tenantId} ORDER BY il.display_order, il.id
    `));
    data.push({ ...item, recommendations: recommendReplenishment(locations as LocationPolicyInput[]) });
  }
  res.json({ items: data });
});

export default router;
