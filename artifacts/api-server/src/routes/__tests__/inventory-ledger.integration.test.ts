import { randomUUID } from "node:crypto";
import express from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@workspace/db";
import { postInventoryMovement } from "../../lib/inventoryMovementLedger";

const enabled = process.env.RUN_INVENTORY_LEDGER_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const header = "x-inventory-ledger-user";
const runId = `s3_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const identities = { admin: `${runId}_admin`, customer: `${runId}_customer` };

vi.mock("@clerk/express", () => ({ getAuth: (req: express.Request) => ({ userId: req.header(header) ?? null }), clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } } }));
import inventoryRouter from "../inventory";

const { Client } = pg;
let client: pg.Client;
let tenant = 0; let tenantB = 0; let admin = 0; let catalog = 0; let catalogB = 0; let nonCatalog = 0; let backstock = 0; let storefront = 0;

function app() {
  const instance = express(); instance.use(express.json()); instance.use("/api", inventoryRouter); return supertest(instance);
}
function asAdmin() { const req = app(); return { get: (path: string) => req.get(path).set(header, identities.admin), post: (path: string) => req.post(path).set(header, identities.admin) }; }
const actor = () => ({ id: admin, email: `${identities.admin}@example.test`, role: "admin" });

suite("canonical inventory ledger acceptance", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/127\.0\.0\.1|localhost/);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false }); await client.connect();
    await client.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable_trigger");
    const tenants = await client.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id,slug", [`${runId} Tenant A`, `${runId}-a`, `${runId} Tenant B`, `${runId}-b`]);
    tenant = tenants.rows.find(row => row.slug === `${runId}-a`).id; tenantB = tenants.rows.find(row => row.slug === `${runId}-b`).id;
    const users = await client.query("INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status) VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active'),($4,$5,$5,'user',$3,'approved',true,'verified','active') RETURNING id,clerk_id", [identities.admin, `${identities.admin}@example.test`, tenant, identities.customer, `${identities.customer}@example.test`,]);
    admin = users.rows.find(row => row.clerk_id === identities.admin).id;
    const locations = await client.query("INSERT INTO inventory_locations(tenant_id,type,name,is_active) VALUES($1,'backstock',$2,true),($1,'storefront',$3,true),($4,'backstock',$5,true) RETURNING id,tenant_id,name", [tenant, `${runId} Backstock`, `${runId} Storefront`, tenantB, `${runId} Other`]);
    backstock = locations.rows.find(row => row.tenant_id === tenant && row.name === `${runId} Backstock`).id; storefront = locations.rows.find(row => row.tenant_id === tenant && row.name === `${runId} Storefront`).id;
    const products = await client.query("INSERT INTO catalog_items(tenant_id,name,category,sku,price,cost_basis,is_available,is_woo_managed,is_local_alavont) VALUES($1,'Acceptance Product A','Acceptance',$2,10,7,true,false,true),($3,'Other Tenant Product','Acceptance',$4,10,7,true,false,true) RETURNING id,tenant_id", [tenant, `${runId}-ACC-S3-PROD-A`, tenantB, `${runId}-OTHER`]);
    catalog = products.rows.find(row => row.tenant_id === tenant).id; catalogB = products.rows.find(row => row.tenant_id === tenantB).id;
    const sections = await client.query("INSERT INTO non_catalog_inventory_sections(tenant_id,name) VALUES($1,$2) RETURNING id", [tenant, `${runId} Supplies`]);
    const supply = await client.query("INSERT INTO non_catalog_inventory_items(tenant_id,section_id,name,unit_of_measure,unit_cost,is_active) VALUES($1,$2,'Receipt Paper','roll',2.50,true) RETURNING id", [tenant, sections.rows[0].id]); nonCatalog = supply.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("DELETE FROM audit_logs WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("UPDATE inventory_receipts SET movement_id=NULL WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_immutable_trigger");
    await client.query("DELETE FROM inventory_movements WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable_trigger");
    await client.query("DELETE FROM inventory_valuation_states WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM inventory_receipts WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM inventory_balances WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM non_catalog_inventory_balances WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM non_catalog_inventory_items WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM non_catalog_inventory_sections WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM catalog_items WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM inventory_locations WHERE tenant_id IN ($1,$2)", [tenant, tenantB]);
    await client.query("DELETE FROM users WHERE clerk_id = ANY($1)", [Object.values(identities)]); await client.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenant, tenantB]); await client.end();
  });

  it("receipts preserve actual cost and calculate weighted average/value", async () => {
    const first = await asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "catalog", itemId: catalog, locationId: backstock, quantity: "10", unitCost: "4.00", supplierReference: "SUP-A", reference: "PO-1", idempotencyKey: `${runId}-receipt-1` }); expect(first.status, first.body.error).toBe(201);
    const second = await asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "catalog", itemId: catalog, locationId: backstock, quantity: "10", unitCost: "6.00", supplierReference: "SUP-A", reference: "PO-2", idempotencyKey: `${runId}-receipt-2` }); expect(second.status, second.body.error).toBe(201);
    const detail = await asAdmin().get(`/api/admin/inventory/catalog/${catalog}/detail`); expect(detail.status).toBe(200); expect(detail.body.item).toMatchObject({ quantityOnHand: "20.000", lastPurchaseCost: "6.000000000000", weightedAverageCost: "5.000000000000", inventoryValue: "100.000000000000" }); expect(detail.body.purchaseHistory).toHaveLength(2); expect(detail.body.purchaseHistory.map((row: { unitCost: string }) => row.unitCost)).toEqual(expect.arrayContaining(["4.000000000000", "6.000000000000"]));
  });

  it("posts one sale at recognized cost and keeps COGS stable after default-cost edits", async () => {
    const sale = await db.transaction(tx => postInventoryMovement(tx, { tenantId: tenant, actor: actor(), entityType: "catalog", itemId: catalog, locationId: backstock, movementType: "sale", quantity: "3", reasonCode: "sale", reasonText: "Acceptance sale", sourceType: "order", sourceId: `${runId}-order-1`, idempotencyKey: `${runId}-sale-1` })); expect(sale).toMatchObject({ quantityDelta: "-3", unitCost: "5.000000000000", extendedCost: "15.000000000000" });
    await client.query("UPDATE catalog_items SET cost_basis=7 WHERE id=$1", [catalog]);
    const detail = await asAdmin().get(`/api/admin/inventory/catalog/${catalog}/detail`); expect(detail.body.item).toMatchObject({ quantityOnHand: "17.000", currentDefaultCost: "7.00", weightedAverageCost: "5.000000000000", inventoryValue: "85.000000000000" }); expect(detail.body.movementHistory.find((row: { movementType: string }) => row.movementType === "sale")).toMatchObject({ extendedCost: "15.000000000000" });
  });

  it("enforces receipt idempotency, transfer conservation, and cross-tenant isolation", async () => {
    const key = `${runId}-idem-receipt`; const payload = { entityType: "catalog", itemId: catalog, locationId: backstock, quantity: "1", unitCost: "5", idempotencyKey: key, reference: "IDEM" };
    expect((await asAdmin().post("/api/admin/inventory/receipts").send(payload)).status).toBe(201); const replay = await asAdmin().post("/api/admin/inventory/receipts").send(payload); expect(replay.status).toBe(200); expect(replay.body.movement.idempotent).toBe(true); expect((await asAdmin().post("/api/admin/inventory/receipts").send({ ...payload, quantity: "2" })).status).toBe(409);
    const transfer = await asAdmin().post("/api/admin/inventory/transfers").send({ entityType: "catalog", itemId: catalog, sourceLocationId: backstock, destinationLocationId: storefront, quantity: "5", reasonText: "Move", idempotencyKey: `${runId}-transfer` }); expect(transfer.status, transfer.body.error).toBe(201); expect(transfer.body.transfer.out.id).toBeTruthy();
    const totals = await client.query("SELECT COALESCE(SUM(quantity_on_hand),0) AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2", [tenant, catalog]); expect(totals.rows[0].quantity).toBe("18.000");
    expect((await asAdmin().post("/api/admin/inventory/receipts").send({ ...payload, itemId: catalogB, idempotencyKey: `${runId}-cross-item` })).status).toBe(404);
    const history = await asAdmin().get(`/api/admin/inventory/movements?entityType=catalog&itemId=${catalog}&movementType=receipt&limit=1`); expect(history.status).toBe(200); expect(history.body.movements).toHaveLength(1); expect(history.body.limit).toBe(1); expect((await asAdmin().get(`/api/admin/inventory/movements?entityType=catalog&itemId=${catalog}&limit=101`)).status).toBe(400);
  });

  it("records non-catalog receipt and usage with valuation cost", async () => {
    const receipt = await asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "non_catalog", itemId: nonCatalog, locationId: backstock, quantity: "12", unitCost: "2.50", supplierReference: "SUP-PAPER", idempotencyKey: `${runId}-paper-receipt` }); expect(receipt.status, receipt.body.error).toBe(201);
    const usage = await asAdmin().post("/api/admin/inventory/movements").send({ entityType: "non_catalog", itemId: nonCatalog, locationId: backstock, movementType: "usage", quantity: "2", reasonCode: "operations", reasonText: "Packing", idempotencyKey: `${runId}-paper-usage` }); expect(usage.status, usage.body.error).toBe(201); expect(usage.body.movement.extendedCost).toBe("5.000000000000"); const detail = await asAdmin().get(`/api/admin/inventory/non_catalog/${nonCatalog}/detail`); expect(detail.body.item).toMatchObject({ quantityOnHand: "10.000", weightedAverageCost: "2.500000000000", inventoryValue: "25.000000000000" }); expect(detail.body.purchaseHistory).toHaveLength(1); expect(detail.body.movementHistory.map((row: { movementType: string }) => row.movementType)).toEqual(expect.arrayContaining(["receipt", "usage"]));
  });

  it("serializes concurrent receipts with numeric weighted-average math", async () => {
    const row = await client.query("INSERT INTO catalog_items(tenant_id,name,category,sku,price,is_available,is_woo_managed,is_local_alavont) VALUES($1,'Concurrent Product','Acceptance',$2,10,true,false,true) RETURNING id", [tenant, `${runId}-CONCURRENT`]);
    const itemId = row.rows[0].id;
    const seed = await asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "catalog", itemId, locationId: backstock, quantity: "10", unitCost: "4", idempotencyKey: `${runId}-concurrent-seed` }); expect(seed.status, seed.body.error).toBe(201);
    const [a, b] = await Promise.all([
      asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "catalog", itemId, locationId: backstock, quantity: "10", unitCost: "6", idempotencyKey: `${runId}-concurrent-a` }),
      asAdmin().post("/api/admin/inventory/receipts").send({ entityType: "catalog", itemId, locationId: backstock, quantity: "10", unitCost: "8", idempotencyKey: `${runId}-concurrent-b` }),
    ]);
    expect(a.status, a.body.error).toBe(201); expect(b.status, b.body.error).toBe(201);
    const detail = await asAdmin().get(`/api/admin/inventory/catalog/${itemId}/detail`); expect(detail.body.item).toMatchObject({ quantityOnHand: "30.000", weightedAverageCost: "6.000000000000", inventoryValue: "180.000000000000" });
    const movements = await client.query("SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND idempotency_key LIKE $2", [tenant, `${runId}-concurrent-%`]); expect(movements.rows[0].count).toBe(3);
  });

  it("keeps ledger rows immutable and rejects unknown/cost-authority fields", async () => {
    const movementId = (await client.query("SELECT id FROM inventory_movements WHERE tenant_id=$1 AND movement_type='sale' LIMIT 1", [tenant])).rows[0].id;
    await expect(client.query("UPDATE inventory_movements SET reason_text='tampered' WHERE id=$1", [movementId])).rejects.toThrow(); await expect(client.query("DELETE FROM inventory_movements WHERE id=$1", [movementId])).rejects.toThrow();
    expect((await asAdmin().post("/api/admin/inventory/movements").send({ entityType: "catalog", itemId: catalog, locationId: backstock, movementType: "usage", quantity: "1", reasonCode: "x", reasonText: "x", idempotencyKey: `${runId}-unknown`, inventoryValue: "0" })).status).toBe(400);
  });

  it("rolls back ledger, balance, valuation, and audit on transaction failure", async () => {
    const before = await client.query("SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenant, catalog, backstock]);
    const key = `${runId}-rollback`;
    await expect(db.transaction(async tx => {
      await postInventoryMovement(tx, { tenantId: tenant, actor: actor(), entityType: "catalog", itemId: catalog, locationId: backstock, movementType: "receipt", quantity: "2", unitCost: "9", reasonCode: "rollback", reasonText: "fault injection", idempotencyKey: key });
      throw new Error("controlled acceptance rollback");
    })).rejects.toThrow();
    const movement = await client.query("SELECT COUNT(*)::int AS count FROM inventory_movements WHERE idempotency_key=$1", [key]);
    const after = await client.query("SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenant, catalog, backstock]);
    expect(movement.rows[0].count).toBe(0);
    expect(after.rows[0]?.quantity_on_hand ?? "0").toBe(before.rows[0]?.quantity_on_hand ?? "0");
  });

  it("posts explicit return, loss, adjustment, and compensating correction movements", async () => {
    const saleId = (await client.query("SELECT id FROM inventory_movements WHERE tenant_id=$1 AND movement_type='sale' ORDER BY id DESC LIMIT 1", [tenant])).rows[0].id;
    const post = (movementType: string, key: string, extra: Record<string, unknown> = {}) => asAdmin().post("/api/admin/inventory/movements").send({ entityType: "catalog", itemId: catalog, locationId: backstock, movementType, quantity: "1", reasonCode: movementType, reasonText: `Acceptance ${movementType}`, idempotencyKey: `${runId}-${key}`, ...extra });
    const returned = await post("customer_return", "return", { sourceId: String(saleId) }); expect(returned.status, returned.body.error).toBe(201); expect(returned.body.movement.unitCost).toBe("5.000000000000");
    for (const type of ["vendor_return", "waste", "damage", "shrinkage", "adjustment_decrease"]) { const response = await post(type, type); expect(response.status, response.body.error).toBe(201); }
    const increased = await post("adjustment_increase", "adjustment-increase", { unitCost: "5" }); expect(increased.status, increased.body.error).toBe(201);
    const correction = await post("correction", "correction", { direction: "increase", sourceId: String(saleId) }); expect(correction.status, correction.body.error).toBe(201);
    const rows = await client.query("SELECT movement_type,reason_code,actor_user_id,location_id FROM inventory_movements WHERE tenant_id=$1 AND idempotency_key LIKE $2 ORDER BY id", [tenant, `${runId}-%`]);
    const explicit = rows.rows.filter(row => ["customer_return", "vendor_return", "waste", "damage", "shrinkage", "adjustment_decrease", "adjustment_increase", "correction"].includes(row.movement_type));
    expect(explicit.map(row => row.movement_type)).toEqual(expect.arrayContaining(["customer_return", "vendor_return", "waste", "damage", "shrinkage", "adjustment_decrease", "adjustment_increase", "correction"])); expect(explicit.every(row => row.actor_user_id === admin && row.location_id === backstock)).toBe(true);
  });
});
