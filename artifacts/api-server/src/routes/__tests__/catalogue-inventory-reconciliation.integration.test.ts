/** Run only against a disposable localhost PostgreSQL clone with migration 0077 applied. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@workspace/db";
import { postInventoryMovement } from "../../lib/inventoryMovementLedger";
import { applyInventoryHistoryBaselineRepair, previewInventoryHistoryBaselineRepair } from "../../lib/inventoryHistoryBaselineRepair";

const enabled = process.env.RUN_CATALOGUE_INVENTORY_RECONCILIATION_INTEGRATION === "1";
const authHeader = "x-reconciliation-user";
vi.mock("@clerk/express", () => ({ getAuth: (req: express.Request) => ({ userId: req.header(authHeader) }), clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } } }));
import productRouter from "../catalogue-products";
import reconciliationRouter from "../catalogue-inventory-reconciliation";

const { Client } = pg;
const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
const users = { admin: `reconcile_admin_${suffix}`, other: `reconcile_other_${suffix}`, foreign: `reconcile_foreign_${suffix}` };
let client: pg.Client; let tenantId: number; let locationId: number;
let foreignTenantId: number;
let product: { productId: number; optionId: number; catalogItemId: number; inventoryItemId: number };
let second: typeof product;
const app = express(); app.use(express.json()); app.use("/api", productRouter, reconciliationRouter);
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(500).json({ error: String(error) }); app.use(errorHandler);
const http = supertest(app);
const requestAs = (who: keyof typeof users) => ({
  post: (path: string) => http.post(path).set(authHeader, users[who]),
  patch: (path: string) => http.patch(path).set(authHeader, users[who]),
  put: (path: string) => http.put(path).set(authHeader, users[who]),
});
const path = () => `/api/admin/catalogue/products/${product.productId}/inventory-reconciliation`;

async function snapshot() {
  const result = await client.query(`SELECT jsonb_build_object(
    'product',(SELECT to_jsonb(p) FROM catalogue_products p WHERE p.tenant_id=$1 AND p.id=$2),
    'options',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM catalogue_options o WHERE o.tenant_id=$1 AND o.product_id=$2),
    'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM inventory_balances b WHERE b.tenant_id=$1 AND b.product_id=ANY($3::int[])),
    'valuation',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]') FROM inventory_valuation_states v WHERE v.tenant_id=$1 AND v.catalog_item_id=ANY($3::int[])),
    'movements',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM inventory_movements m WHERE m.tenant_id=$1 AND m.catalog_item_id=ANY($3::int[])),
    'legacyHistory',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM inventory_transaction_log l WHERE l.tenant_id=$1 AND l.catalog_item_id=ANY($3::int[])),
    'events',(SELECT count(*) FROM catalogue_inventory_reconciliation_events e WHERE e.tenant_id=$1 AND e.product_id=$2)) AS state`,
  [tenantId, product.productId, [product.catalogItemId, second.catalogItemId]]);
  return JSON.stringify(result.rows[0].state);
}

(enabled ? describe : describe.skip)("audited catalogue inventory reconciliation on disposable PostgreSQL", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    process.env.MYORDER_OWNER_CLERK_ID = users.admin;
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false }); await client.connect();
    const migration = await client.query("SELECT to_regclass('catalogue_inventory_reconciliation_events') AS event_table");
    expect(migration.rows[0].event_table).toBe("catalogue_inventory_reconciliation_events");
    const tenant = await client.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Reconciliation ${suffix}`, `reconciliation-${suffix}`]); tenantId = tenant.rows[0].id;
    const foreignTenant = await client.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Foreign ${suffix}`, `foreign-${suffix}`]); foreignTenantId = foreignTenant.rows[0].id;
    await client.query(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
      VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active'),($4,$5,$5,'user',$3,'approved',true,'verified','active')`,
    [users.admin, `${users.admin}@example.test`, tenantId, users.other, `${users.other}@example.test`]);
    await client.query(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
      VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active')`, [users.foreign, `${users.foreign}@example.test`, foreignTenantId]);
    const loc = await client.query("INSERT INTO inventory_locations(tenant_id,type,name,is_active) VALUES($1,'backstock',$2,true) RETURNING id", [tenantId, `Reconcile ${suffix}`]); locationId = loc.rows[0].id;
    const create = await requestAs("admin").post("/api/admin/catalogue/products").send({ name: `Variant Stock ${suffix}`, category: "Test", price: "10.00", inventoryModel: "SEPARATE_VARIANTS", baseUnit: "each", consumptionQuantity: "1.000000" });
    expect(create.status, create.text).toBe(201); product = create.body;
    const option = await requestAs("admin").post(`/api/admin/catalogue/products/${product.productId}/options`).send({ label: "Large", price: "12.00", consumptionQuantity: "2.000000" });
    expect(option.status, option.text).toBe(201); second = { productId: product.productId, optionId: option.body.optionId, catalogItemId: option.body.catalogItemId, inventoryItemId: option.body.inventoryItemId };
    const adminRow = await client.query("SELECT id FROM users WHERE clerk_id=$1", [users.admin]); const adminId = Number(adminRow.rows[0].id);
    for (const [item, quantity, unitCost] of [[product, "3.000000", "2.50"], [second, "2.000000", "3.00"]] as const) {
      await db.transaction(tx => postInventoryMovement(tx, { tenantId, actor: { id: adminId, role: "admin" }, entityType: "catalog",
        itemId: item.catalogItemId, locationId, movementType: "adjustment_increase", quantity, unitCost,
        sourceType: "reconciliation_test_setup", sourceId: suffix, reasonCode: "test_fixture", reasonText: "Disposable integration fixture",
        idempotencyKey: `reconcile-fixture:${suffix}:${item.catalogItemId}` }));
      await client.query(`UPDATE inventory_valuation_states SET cost_status='unknown_baseline',known_quantity=0,
        average_unit_cost=NULL,inventory_value=NULL,last_purchase_unit_cost=NULL WHERE tenant_id=$1 AND catalog_item_id=$2`, [tenantId,item.catalogItemId]);
    }
    await client.query(`INSERT INTO inventory_transaction_log(tenant_id,transaction_id,type,catalog_item_id,location_id,quantity_change,before_state,after_state)
      VALUES($1,$2,'import',$3,$4,0,'{}'::jsonb,'{}'::jsonb)`, [tenantId, `legacy-reconcile-${suffix}`, product.catalogItemId, locationId]);
  }, 30_000);
  afterAll(async () => { if (client) await client.end(); });

  it("enforces admin permissions and strict request schemas", async () => {
    const before = await snapshot();
    const denied = await requestAs("other").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId } });
    expect(denied.status).toBe(403);
    const malformed = await requestAs("admin").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId }, inventoryModel: "SHARED" });
    expect(malformed.status).toBe(400);
    const directSwitch = await requestAs("admin").patch(`/api/admin/catalogue/products/${product.productId}`).send({ inventoryModel: "SHARED" });
    expect(directSwitch.status).toBe(409); expect(directSwitch.body.code).toBe("CONTROLLED_RECONCILIATION_REQUIRED");
    await expect(client.query("UPDATE catalogue_products SET inventory_model='SHARED' WHERE tenant_id=$1 AND id=$2", [tenantId,product.productId]))
      .rejects.toMatchObject({ code: "P0001" });
    expect(await snapshot()).toBe(before);
  });

  it("creates G (BDO) with omitted display fields as Shared variants and preserves each variant's data", async () => {
    const response = await requestAs("admin").post("/api/admin/catalogue/products").send({
      name: "G (BDO)", inventoryModel: "SHARED", locationEvaluation: "PER_LOCATION", baseUnit: "each",
      variants: [
        { label: "Small", optionValues: { Size: "Small" }, price: "12.00", sku: `g-bdo-s-${suffix}`, barcode: `bdo-s-${suffix}`, consumptionQuantity: "1.000000", isAvailable: true },
        { label: "Large", optionValues: { Size: "Large" }, price: "18.00", sku: `g-bdo-l-${suffix}`, barcode: `bdo-l-${suffix}`, consumptionQuantity: "2.500000", isAvailable: false },
      ],
    });
    expect(response.status, response.text).toBe(201);
    const created = await client.query(`SELECT p.inventory_model,p.location_evaluation,co.label,co.option_values,co.inventory_item_id,
      co.consumption_quantity::text,ci.category,ci.merchant_brand,ci.customer_safe_name,ci.customer_safe_description,
      ci.display_category,ci.merchant_name,ci.price::text,ci.sku,ci.barcode,ci.is_available
      FROM catalogue_products p JOIN catalogue_options co ON co.tenant_id=p.tenant_id AND co.product_id=p.id
      JOIN catalog_items ci ON ci.tenant_id=co.tenant_id AND ci.id=co.catalog_item_id WHERE p.tenant_id=$1 AND p.id=$2 AND co.active=true ORDER BY co.id`,
    [tenantId, response.body.productId]);
    expect(created.rows).toHaveLength(2);
    expect(created.rows.every((row: any) => row.inventory_model === "SHARED" && row.location_evaluation === "PER_LOCATION"
      && row.inventory_item_id === response.body.sharedInventoryItemId && row.category && row.merchant_brand
      && row.customer_safe_name && row.customer_safe_description && row.display_category && row.merchant_name)).toBe(true);
    expect(created.rows.map((row: any) => [row.label,row.option_values,row.consumption_quantity,row.price,row.sku,row.barcode,row.is_available]))
      .toEqual([["Small",{ Size: "Small" },"1.000000","12.00",`g-bdo-s-${suffix}`,`bdo-s-${suffix}`,true],
        ["Large",{ Size: "Large" },"2.500000","18.00",`g-bdo-l-${suffix}`,`bdo-l-${suffix}`,false]]);
  });

  it("returns a sanitized error when the catalog_items insert is rejected", async () => {
    await client.query(`CREATE OR REPLACE FUNCTION reject_catalogue_create_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_items_test_guard', MESSAGE='simulated catalog create rejection', DETAIL='sensitive submitted values'; END $$;
      CREATE TRIGGER zz_reject_catalogue_create_test BEFORE INSERT ON catalog_items FOR EACH ROW EXECUTE FUNCTION reject_catalogue_create_test()`);
    try {
      const response = await requestAs("admin").post("/api/admin/catalogue/products").send({ name: "G (BDO)", variants: [
        { label: "Standard", price: "1.00", consumptionQuantity: "1", optionValues: {} },
      ] });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("PRODUCT_CREATE_FAILED");
      expect(response.body.error).toMatch(/No changes were saved/);
      expect(response.text).not.toContain("Failed query");
      expect(response.text).not.toContain("sensitive submitted values");
      expect(response.text).not.toContain("catalog_items_test_guard");
    } finally {
      await client.query("DROP TRIGGER zz_reject_catalogue_create_test ON catalog_items; DROP FUNCTION reject_catalogue_create_test()");
    }
  });

  it("previews actual linked IDs, per-location stock and converted consumption without writing", async () => {
    const before = await snapshot();
    const response = await requestAs("admin").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId } });
    expect(response.status, response.text).toBe(200);
    expect(response.body.variants.map((v: any) => [v.optionId, v.inventoryItemId, v.catalogItemId, v.proposedConsumption]))
      .toEqual([[product.optionId, product.inventoryItemId, product.catalogItemId, "1.000000"], [second.optionId, second.inventoryItemId, second.catalogItemId, "2.000000"]]);
    expect(response.body.locations[0].proposedSharedBalance).toBe("5.000000");
    expect(response.body.legacyHistory).toEqual([{ catalogItemId: product.catalogItemId, locationId, transactionCount: 1, netQuantityChange: "0.000000" }]);
    expect(response.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const incompatibleUnit = await requestAs("admin").post(`${path()}/preview`).send({ target: { create: { name: `Mass item ${suffix}`, baseUnit: "kg" } } });
    expect(incompatibleUnit.status, incompatibleUnit.text).toBe(200);
    expect(incompatibleUnit.body.issues.join(" ")).toMatch(/No verified conversion exists/);
    expect(incompatibleUnit.body.locations[0].proposedSharedBalance).toMatch(/Unavailable/);
    const duplicate = await requestAs("admin").post(`${path()}/preview`).send({ target: { create: { name: `Variant Stock ${suffix}`, baseUnit: "each" } } });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.issues.join(" ")).toMatch(/already exists/);
    const rejectedDuplicate = await requestAs("admin").post(`${path()}/apply`).send({ target: { create: { name: `Variant Stock ${suffix}`, baseUnit: "each" } },
      previewFingerprint: duplicate.body.fingerprint, confirmPreview: true, idempotencyKey: randomUUID(), reason: "Avoid duplicate shared stock item",
      manualUnitCost: "2.50", costBasisNote: "Supplier invoice verified" });
    expect(rejectedDuplicate.status).toBe(409);
    expect(await snapshot()).toBe(before);
  });

  it("blocks a balance whose ledger history conflicts and makes no write", async () => {
    await client.query("UPDATE inventory_balances SET quantity_on_hand=4 WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantId, product.catalogItemId, locationId]);
    const preview = await requestAs("admin").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId } });
    expect(preview.status).toBe(200);
    expect(preview.body.issues.join(" ")).toMatch(/history does not reconcile/);
    await client.query("UPDATE inventory_balances SET quantity_on_hand=3 WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantId, product.catalogItemId, locationId]);
  });

  it("blocks active reservations and open committed order stock without changing inventory", async () => {
    const adminId = Number((await client.query("SELECT id FROM users WHERE clerk_id=$1", [users.admin])).rows[0].id);
    const order = await client.query(`INSERT INTO orders(tenant_id,customer_id,subtotal,total,status,payment_status,payment_method)
      VALUES($1,$2,10,10,'pending','unpaid','cash') RETURNING id`, [tenantId,adminId]);
    const orderId = Number(order.rows[0].id);
    try {
      const orderItem = await client.query(`INSERT INTO order_items(order_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price,option_id,inventory_item_id)
        VALUES($1,$2,'Reserved variant',1,10,10,$3,$4) RETURNING id`, [orderId,product.catalogItemId,product.optionId,product.inventoryItemId]);
      await client.query(`INSERT INTO inventory_reservations(order_id,catalog_item_id,location_id,quantity,status,expires_at,order_item_id)
        VALUES($1,$2,$3,1,'reserved',now()+interval '10 minutes',$4)`, [orderId,product.catalogItemId,locationId,orderItem.rows[0].id]);
      const before = await snapshot();
      const preview = await requestAs("admin").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId } });
      expect(preview.status).toBe(200);
      expect(preview.body.issues.join(" ")).toMatch(/reservations/);
      expect(preview.body.issues.join(" ")).toMatch(/open orders/);
      expect(await snapshot()).toBe(before);
    } finally {
      await client.query("DELETE FROM inventory_reservations WHERE order_id=$1", [orderId]);
      await client.query("DELETE FROM order_items WHERE order_id=$1", [orderId]);
      await client.query("DELETE FROM orders WHERE id=$1", [orderId]);
    }
  });

  it("requires documented positive cost, blocks stale previews, and prevents duplicate submission", async () => {
    const preview = await requestAs("admin").post(`${path()}/preview`).send({ target: { inventoryItemId: product.inventoryItemId } });
    const base = { target: { inventoryItemId: product.inventoryItemId }, previewFingerprint: preview.body.fingerprint,
      confirmPreview: true, idempotencyKey: randomUUID(), reason: "Consolidate variant inventory" };
    const before = await snapshot();
    const missingCost = await requestAs("admin").post(`${path()}/apply`).send(base);
    expect(missingCost.status).toBe(422); expect(missingCost.body.code).toBe("VERIFIED_COST_REQUIRED"); expect(await snapshot()).toBe(before);
    const alteredFingerprint = `${preview.body.fingerprint[0] === "0" ? "1" : "0"}${preview.body.fingerprint.slice(1)}`;
    const stalePreview = await requestAs("admin").post(`${path()}/apply`).send({ ...base, manualUnitCost: "2.50", costBasisNote: "Supplier invoice verified", previewFingerprint: alteredFingerprint });
    expect(stalePreview.status).toBe(409); expect(stalePreview.body.code).toBe("STALE_PREVIEW"); expect(await snapshot()).toBe(before);
    const good = { ...base, manualUnitCost: "2.50", costBasisNote: "Supplier invoice verified" };
    await client.query(`CREATE OR REPLACE FUNCTION reject_reconciliation_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.inventory_model='SHARED' THEN RAISE EXCEPTION 'simulated late reconciliation failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_reject_reconciliation_test BEFORE UPDATE OF inventory_model ON catalogue_products FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_test()`);
    const rollbackBefore = await snapshot();
    const rejected = await requestAs("admin").post(`${path()}/apply`).send(good);
    expect(rejected.status).toBe(409); expect(await snapshot()).toBe(rollbackBefore);
    await client.query("DROP TRIGGER zz_reject_reconciliation_test ON catalogue_products; DROP FUNCTION reject_reconciliation_test()");
    const concurrent = await Promise.all([requestAs("admin").post(`${path()}/apply`).send(good), requestAs("admin").post(`${path()}/apply`).send(good)]);
    const applied = concurrent.find(response => response.status === 201)!;
    const duplicate = concurrent.find(response => response.status === 200)!;
    expect(applied, concurrent.map(r => `${r.status}:${r.text}`).join(" ")).toBeTruthy();
    expect(duplicate?.body.idempotent).toBe(true); expect(duplicate?.body.reconciliationId).toBe(applied.body.reconciliationId);
    const repeated = await requestAs("admin").post(`${path()}/apply`).send(good);
    expect(repeated.status).toBe(200); expect(repeated.body.idempotent).toBe(true);
    const verified = await client.query(`SELECT p.inventory_model,co.inventory_item_id,co.consumption_quantity::text AS consumption,ci.price::text AS price
      FROM catalogue_products p JOIN catalogue_options co ON co.tenant_id=p.tenant_id AND co.product_id=p.id
      JOIN catalog_items ci ON ci.tenant_id=co.tenant_id AND ci.id=co.catalog_item_id WHERE p.tenant_id=$1 AND p.id=$2 AND co.active=true ORDER BY co.id`, [tenantId, product.productId]);
    expect(verified.rows).toHaveLength(2); expect(verified.rows.every((r: any) => r.inventory_model === "SHARED" && r.inventory_item_id === product.inventoryItemId)).toBe(true);
    expect(verified.rows.map((r: any) => r.price)).toEqual(["10.00", "12.00"]);
    const balance = await client.query("SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantId, product.catalogItemId, locationId]);
    expect(balance.rows[0].quantity).toBe("5.000000");
    const evidence = await client.query("SELECT finalized_at IS NOT NULL AS finalized,evidence->'movements' AS movements,evidence->'costBasis' AS cost_basis FROM catalogue_inventory_reconciliation_events WHERE tenant_id=$1 AND product_id=$2 AND id=$3::uuid", [tenantId, product.productId, applied.body.reconciliationId]);
    expect(evidence.rows[0].finalized).toBe(true); expect(evidence.rows[0].movements).toHaveLength(1);
    expect(evidence.rows[0].cost_basis).toMatchObject({ kind: "operator_documented", unitCost: "2.50", note: "Supplier invoice verified" });
    const audit = await client.query("SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id=$1 AND action='CATALOGUE_INVENTORY_RECONCILED' AND resource_id=$2", [tenantId, String(product.productId)]);
    expect(audit.rows[0].count).toBe(1);
    const legacy = await client.query("SELECT count(*)::int AS count FROM inventory_transaction_log WHERE tenant_id=$1 AND transaction_id=$2", [tenantId, `legacy-reconcile-${suffix}`]);
    expect(legacy.rows[0].count).toBe(1);
    const rollback = await requestAs("admin").post(`${path()}/${applied.body.reconciliationId}/rollback`).send({ idempotencyKey: randomUUID(), reason: "Reverse verified staging reconciliation" });
    expect(rollback.status, rollback.text).toBe(201);
    const restored = await client.query(`SELECT p.inventory_model,co.id AS option_id,co.inventory_item_id,b.quantity_on_hand::text AS quantity
      FROM catalogue_products p JOIN catalogue_options co ON co.tenant_id=p.tenant_id AND co.product_id=p.id
      JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
      LEFT JOIN inventory_balances b ON b.tenant_id=ii.tenant_id AND b.product_id=ii.catalog_item_id AND b.location_id=$3
      WHERE p.tenant_id=$1 AND p.id=$2 AND co.active=true ORDER BY co.id`, [tenantId, product.productId, locationId]);
    expect(restored.rows.map((r: any) => [r.inventory_model, r.option_id, r.inventory_item_id, r.quantity])).toEqual([
      ["SEPARATE_VARIANTS", product.optionId, product.inventoryItemId, "3.000000"],
      ["SEPARATE_VARIANTS", second.optionId, second.inventoryItemId, "2.000000"],
    ]);
    const compensation = await client.query("SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND source_type='catalogue_inventory_reconciliation_rollback' AND source_id=$2", [tenantId, rollback.body.rollbackId]);
    expect(compensation.rows[0].count).toBe(2);
  });

  it("previews and appends a tenant-scoped history baseline without changing physical balances", async () => {
    const local = await requestAs("admin").post("/api/admin/catalogue/products").send({ name: `Baseline ${suffix}`, category: "Test", price: "10.00", inventoryModel: "SEPARATE_VARIANTS", baseUnit: "each", consumptionQuantity: "1.000000" });
    expect(local.status, local.text).toBe(201);
    const foreignLocation = await client.query("INSERT INTO inventory_locations(tenant_id,type,name,is_active) VALUES($1,'backstock',$2,true) RETURNING id", [foreignTenantId, `Foreign ${suffix}`]);
    process.env.MYORDER_OWNER_CLERK_ID = users.foreign;
    const foreign = await requestAs("foreign").post("/api/admin/catalogue/products").send({ name: `Foreign baseline ${suffix}`, category: "Test", price: "10.00", inventoryModel: "SEPARATE_VARIANTS", baseUnit: "each", consumptionQuantity: "1.000000" });
    process.env.MYORDER_OWNER_CLERK_ID = users.admin;
    expect(foreign.status, foreign.text).toBe(201);
    await client.query(`INSERT INTO inventory_balances(tenant_id,product_id,location_id,quantity_on_hand,par_level)
      VALUES($1,$2,$3,2,0),($4,$5,$6,9,0)`, [tenantId, local.body.catalogItemId, locationId, foreignTenantId, foreign.body.catalogItemId, foreignLocation.rows[0].id]);
    const evidence = [{ inventoryItemId: local.body.inventoryItemId, locationId, verifiedPhysicalQuantity: "2.000000", documentedUnitCost: "3.25",
      physicalCountNote: "Count sheet witnessed by two staff", costBasisNote: "Supplier invoice reviewed" }];
    const before = await client.query("SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantId,local.body.catalogItemId,locationId]);
    const adminId = Number((await client.query("SELECT id FROM users WHERE clerk_id=$1", [users.admin])).rows[0].id);
    const openOrder = await client.query(`INSERT INTO orders(tenant_id,customer_id,subtotal,total,status,payment_status,payment_method)
      VALUES($1,$2,1,1,'pending','unpaid','cash') RETURNING id`, [tenantId,adminId]);
    await client.query(`INSERT INTO inventory_reservations(order_id,catalog_item_id,location_id,quantity,status,expires_at)
      VALUES($1,$2,$3,1,'reserved',now()+interval '10 minutes')`, [openOrder.rows[0].id,local.body.catalogItemId,locationId]);
    const blocked = await previewInventoryHistoryBaselineRepair(tenantId, local.body.productId, evidence);
    expect(blocked.blockers.join(" ")).toMatch(/Active reservations/);
    await client.query("DELETE FROM inventory_reservations WHERE order_id=$1", [openOrder.rows[0].id]);
    await client.query("DELETE FROM orders WHERE id=$1", [openOrder.rows[0].id]);
    const preview = await previewInventoryHistoryBaselineRepair(tenantId, local.body.productId, evidence);
    expect(preview.blockers).toEqual([]); expect(preview.corrections[0]).toMatchObject({ bridgeQuantityDelta: "2.000000", ledgerQuantity: "0" });
    expect((await client.query("SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantId,local.body.catalogItemId])).rows[0].count).toBe(0);
    const foreignAdminId = Number((await client.query("SELECT id FROM users WHERE clerk_id=$1", [users.foreign])).rows[0].id);
    await expect(applyInventoryHistoryBaselineRepair({ tenantId, productId: local.body.productId, evidence, previewFingerprint: preview.fingerprint,
      idempotencyKey: randomUUID(), reason: "Attempt a cross-tenant baseline repair", actor: { id: foreignAdminId, role: "admin" } }))
      .rejects.toMatchObject({ status: 403 });
    expect((await client.query("SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantId,local.body.catalogItemId])).rows[0].count).toBe(0);
    const idempotencyKey = randomUUID();
    const applied = await applyInventoryHistoryBaselineRepair({ tenantId, productId: local.body.productId, evidence, previewFingerprint: preview.fingerprint,
      idempotencyKey, reason: "Establish reviewed opening history baseline", actor: { id: adminId, role: "admin" } });
    expect(applied.idempotent).toBe(false); expect(applied.movementIds).toHaveLength(1);
    const repeated = await applyInventoryHistoryBaselineRepair({ tenantId, productId: local.body.productId, evidence, previewFingerprint: preview.fingerprint,
      idempotencyKey, reason: "Establish reviewed opening history baseline", actor: { id: adminId, role: "admin" } });
    expect(repeated).toMatchObject({ repairId: applied.repairId, idempotent: true });
    const after = await client.query("SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantId,local.body.catalogItemId,locationId]);
    expect(after.rows).toEqual(before.rows);
    const ledger = await client.query("SELECT SUM(quantity_delta)::text AS quantity,MIN(source_type) AS source_type FROM inventory_movements WHERE tenant_id=$1 AND catalog_item_id=$2 AND location_id=$3", [tenantId,local.body.catalogItemId,locationId]);
    expect(ledger.rows[0]).toEqual({ quantity: "2.000000000000", source_type: "verified_physical_count_history_bridge" });
    const valuation = await client.query("SELECT cost_status,known_quantity::text,average_unit_cost::text,inventory_value::text FROM inventory_valuation_states WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantId,local.body.catalogItemId]);
    expect(valuation.rows[0]).toEqual({ cost_status: "known", known_quantity: "2.000000000000", average_unit_cost: "3.250000000000", inventory_value: "6.500000000000" });
    await expect(client.query("UPDATE inventory_history_baseline_repair_events SET reason='tampered' WHERE id=$1", [applied.repairId]))
      .rejects.toMatchObject({ code: "P0001" });
    const crossed = await previewInventoryHistoryBaselineRepair(tenantId, local.body.productId, [{ ...evidence[0], inventoryItemId: foreign.body.inventoryItemId, locationId: Number(foreignLocation.rows[0].id) }]);
    expect(crossed.blockers.join(" ")).toMatch(/not an active balance for this product and tenant/);
    expect((await client.query("SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2", [foreignTenantId,foreign.body.catalogItemId])).rows[0].quantity).toBe("9.000000");
  });

});
