/**
 * Disposable-DB HTTP acceptance for Slice 2.  It intentionally uses the real
 * router, Drizzle connection, transaction log, and audit table.  Clerk is
 * replaced only with the established synthetic-auth convention so that each
 * request still traverses the production auth/role middleware and reaches the
 * disposable PostgreSQL database.
 */
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_NON_CATALOG_INTEGRATION === "1";
const integrationDescribe = enabled ? describe : describe.skip;
const acceptanceUserHeader = "x-non-catalog-acceptance-user";

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => {
    const userId = req.header(acceptanceUserHeader);
    return userId ? { userId } : {};
  },
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));

import inventoryRouter, { parseNonCatalogId } from "../inventory";

const { Client } = pg;
const runId = `slice2_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const identities = {
  adminA: `${runId}_admin_a`,
  viewerA: `${runId}_viewer_a`,
  adminB: `${runId}_admin_b`,
};
let client: pg.Client;
let tenantA = 0; let tenantB = 0; let adminA = 0; let locationA = 0; let locationB = 0; let storefrontA = 0; let csrBoxA = 0; let inactiveLocationA = 0;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never; next(); });
  instance.use("/api", inventoryRouter);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(Number(error?.status) || 500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  instance.use(errorHandler);
  return supertest(instance);
}

function as(identity: keyof typeof identities) {
  const request = app();
  return {
    get: (path: string) => request.get(path).set(acceptanceUserHeader, identities[identity]),
    post: (path: string) => request.post(path).set(acceptanceUserHeader, identities[identity]),
    patch: (path: string) => request.patch(path).set(acceptanceUserHeader, identities[identity]),
    delete: (path: string) => request.delete(path).set(acceptanceUserHeader, identities[identity]),
  };
}

integrationDescribe("non-catalog inventory disposable-DB acceptance", () => {
  it("accepts only a scalar positive identifier", () => {
    expect(parseNonCatalogId("123")).toBe(123);
    expect(parseNonCatalogId("1")).toBe(1);
    expect(parseNonCatalogId(["123"])).toBeNull();
    expect(parseNonCatalogId(["123", "124"])).toBeNull();
    expect(parseNonCatalogId(["bad"])).toBeNull();
    expect(parseNonCatalogId([123])).toBeNull();
    expect(parseNonCatalogId(123)).toBeNull();
    expect(parseNonCatalogId("12.3")).toBeNull();
    expect(parseNonCatalogId("0")).toBeNull();
    expect(parseNonCatalogId("")).toBeNull();
    expect(parseNonCatalogId(undefined)).toBeNull();
  });

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/127\.0\.0\.1|localhost/);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false }); await client.connect();
    const tenants = await client.query("INSERT INTO tenants(name, slug, status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id, slug", [`Acceptance Tenant A ${runId}`, `${runId}-a`, `Acceptance Tenant B ${runId}`, `${runId}-b`]);
    tenantA = tenants.rows.find(row => row.slug === `${runId}-a`).id; tenantB = tenants.rows.find(row => row.slug === `${runId}-b`).id;
    const users = await client.query("INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status) VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active'),($4,$5,$5,'user',$3,'approved',true,'verified','active'),($6,$7,$7,'admin',$8,'approved',true,'verified','active') RETURNING id, clerk_id", [identities.adminA, `${identities.adminA}@example.test`, tenantA, identities.viewerA, `${identities.viewerA}@example.test`, identities.adminB, `${identities.adminB}@example.test`, tenantB]);
    adminA = users.rows.find(row => row.clerk_id === identities.adminA).id;
    const locations = await client.query("INSERT INTO inventory_locations(tenant_id,type,name,is_active) VALUES($1,'backstock',$2,true),($3,'backstock',$4,true),($1,'storefront',$5,true),($1,'csr_box',$6,true),($1,'backstock',$7,false) RETURNING id, tenant_id, name", [tenantA, `Acceptance A Location ${runId}`, tenantB, `Acceptance B Location ${runId}`, `Acceptance A Storefront ${runId}`, `Acceptance A CSR ${runId}`, `Acceptance A Inactive ${runId}`]);
    locationA = locations.rows.find(row => row.name === `Acceptance A Location ${runId}`).id;
    locationB = locations.rows.find(row => row.name === `Acceptance B Location ${runId}`).id;
    storefrontA = locations.rows.find(row => row.name === `Acceptance A Storefront ${runId}`).id;
    csrBoxA = locations.rows.find(row => row.name === `Acceptance A CSR ${runId}`).id;
    inactiveLocationA = locations.rows.find(row => row.name === `Acceptance A Inactive ${runId}`).id;
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("DELETE FROM audit_logs WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_immutable_trigger");
    await client.query("DELETE FROM inventory_movements WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable_trigger");
    await client.query("DELETE FROM inventory_valuation_states WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM inventory_transaction_log WHERE transaction_id LIKE $1", [`noncatalog:${tenantA}:%`]);
    await client.query("DELETE FROM non_catalog_inventory_balances WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM non_catalog_inventory_items WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM non_catalog_inventory_sections WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM inventory_locations WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM csr_boxes WHERE tenant_id IN ($1,$2)", [tenantA, tenantB]);
    await client.query("DELETE FROM users WHERE clerk_id = ANY($1)", [Object.values(identities)]);
    await client.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
    await client.end();
  });

  it("requires authentication and an inventory-managing role", async () => {
    expect((await app().get("/api/admin/non-catalog/sections")).status).toBe(401);
    expect((await as("viewerA").get("/api/admin/non-catalog/sections")).status).toBe(403);
    expect((await as("viewerA").post("/api/admin/non-catalog/sections").send({ name: "Denied" })).status).toBe(403);
  });

  it("exposes active tenant locations for balance creation without an existing balance", async () => {
    const response = await as("adminA").get("/api/admin/inventory");
    expect(response.status).toBe(200);
    const ids = response.body.locations.map((location: { id: number }) => location.id);
    expect(ids).toContain(locationA);
    expect(ids).toContain(storefrontA);
    expect(ids).toContain(csrBoxA);
    expect(ids).not.toContain(locationB);
    expect(ids).not.toContain(inactiveLocationA);
    expect((await client.query("SELECT id FROM non_catalog_inventory_balances WHERE tenant_id=$1 AND location_id=$2", [tenantA, locationA])).rowCount).toBe(0);
  });

  it("persists sections and the complete canonical non-catalog item shape", async () => {
    const list = await as("adminA").get("/api/admin/non-catalog/sections"); expect(list.status).toBe(200);
    const badTenant = await as("adminA").post("/api/admin/non-catalog/sections").send({ name: "Bad", tenant_id: tenantB }); expect(badTenant.status).toBe(400);
    const created = await as("adminA").post("/api/admin/non-catalog/sections").send({ name: "Shipping Supplies" }); expect(created.status).toBe(201); const section = created.body.section;
    expect((await as("adminA").get(`/api/admin/non-catalog/sections/${section.id}`)).status).toBe(200);
    const renamed = await as("adminA").patch(`/api/admin/non-catalog/sections/${section.id}`).send({ name: "Shipping & Supplies" }); expect(renamed.status).toBe(200);
    const badField = await as("adminA").post("/api/admin/non-catalog/items").send({ name: "Bad item", tenantId: tenantB }); expect(badField.status).toBe(400);
    const createdItem = await as("adminA").post("/api/admin/non-catalog/items").send({ name: "Acceptance Shipping Box", description: "Controlled shipping box", sectionId: section.id, sku: "ACCEPT-BOX-01", barcode: "123456789012", unitOfMeasure: "each", parLevel: 12, moq: 24, preferredReorderQuantity: 36, unitCost: 2.75, supplier: "Acceptance Supply Co", supplierSku: "SUP-BOX-01", notes: "Keep dry" });
    expect(createdItem.status).toBe(201); const item = createdItem.body.item;
    expect(item).toMatchObject({ name: "Acceptance Shipping Box", description: "Controlled shipping box", sectionId: section.id, sku: "ACCEPT-BOX-01", barcode: "123456789012", unitOfMeasure: "each", parLevel: "12.000", moq: "24.000", preferredReorderQuantity: "36.000", unitCost: "2.75", supplier: "Acceptance Supply Co", supplierSku: "SUP-BOX-01", notes: "Keep dry", isActive: true });
    expect((await as("adminA").get("/api/admin/non-catalog/items")).body.items.some((row: { id: number }) => row.id === item.id)).toBe(true);
    expect((await as("adminA").get(`/api/admin/non-catalog/items/${item.id}`)).status).toBe(200);
    const patched = await as("adminA").patch(`/api/admin/non-catalog/items/${item.id}`).send({ description: "Persisted edit", preferredReorderQuantity: 48 }); expect(patched.status).toBe(200); expect(patched.body.item).toMatchObject({ description: "Persisted edit", preferredReorderQuantity: "48.000" });
    const persisted = await client.query("SELECT name,description,section_id,sku,barcode,unit_of_measure,par_level,moq,preferred_reorder_quantity,unit_cost,supplier,supplier_sku,notes,is_active FROM non_catalog_inventory_items WHERE id=$1", [item.id]);
    expect(persisted.rows[0]).toMatchObject({ name: "Acceptance Shipping Box", description: "Persisted edit", section_id: section.id, sku: "ACCEPT-BOX-01", barcode: "123456789012", unit_of_measure: "each", par_level: "12.000", moq: "24.000", preferred_reorder_quantity: "48.000", unit_cost: "2.75", supplier: "Acceptance Supply Co", supplier_sku: "SUP-BOX-01", notes: "Keep dry", is_active: true });
  });

  it("rejects direct cross-tenant object substitution for every non-catalog object", async () => {
    const section = (await client.query("SELECT id FROM non_catalog_inventory_sections WHERE tenant_id=$1 LIMIT 1", [tenantA])).rows[0]; const item = (await client.query("SELECT id FROM non_catalog_inventory_items WHERE tenant_id=$1 LIMIT 1", [tenantA])).rows[0];
    const createB = await as("adminB").post("/api/admin/non-catalog/sections").send({ name: "Tenant B Section" }); expect(createB.status).toBe(201);
    expect((await as("adminB").get(`/api/admin/non-catalog/sections/${section.id}`)).status).toBe(404);
    expect((await as("adminB").patch(`/api/admin/non-catalog/sections/${section.id}`).send({ name: "Takeover" })).status).toBe(404);
    expect((await as("adminB").delete(`/api/admin/non-catalog/sections/${section.id}`)).status).toBe(404);
    expect((await as("adminB").get(`/api/admin/non-catalog/items/${item.id}`)).status).toBe(404);
    expect((await as("adminB").patch(`/api/admin/non-catalog/items/${item.id}`).send({ name: "Takeover" })).status).toBe(404);
    expect((await as("adminB").delete(`/api/admin/non-catalog/items/${item.id}`)).status).toBe(404);
    expect((await as("adminB").post("/api/admin/non-catalog/items").send({ name: "Cross tenant section", sectionId: section.id })).status).toBe(404);
    const mutation = { itemId: item.id, locationId: locationA, quantityDelta: 1, reason: "ADJUSTMENT", idempotencyKey: `${runId}-cross-tenant-key` };
    expect((await as("adminA").post("/api/admin/non-catalog/balances/adjust").send({ ...mutation, locationId: 999999999, idempotencyKey: `${runId}-unknown-location` })).status).toBe(404);
    expect((await as("adminA").post("/api/admin/non-catalog/balances/adjust").send({ ...mutation, locationId: locationB, idempotencyKey: `${runId}-tenant-b-location` })).status).toBe(404);
    expect((await as("adminA").post("/api/admin/non-catalog/balances/adjust").send({ ...mutation, locationId: inactiveLocationA, idempotencyKey: `${runId}-inactive-location` })).status).toBe(404);
    expect((await as("adminB").post("/api/admin/non-catalog/balances/adjust").send(mutation)).status).toBe(404);
    expect((await as("adminB").post("/api/admin/non-catalog/balances/adjust").send({ ...mutation, itemId: item.id, locationId: locationB, idempotencyKey: `${runId}-cross-tenant-location` })).status).toBe(404);
  });

  it("applies balance mutations exactly once and writes matching immutable movement/audit records", async () => {
    const itemId = (await client.query("SELECT id FROM non_catalog_inventory_items WHERE tenant_id=$1 LIMIT 1", [tenantA])).rows[0].id;
    const initial = { itemId, locationId: locationA, quantityDelta: 10, reason: "INITIAL", idempotencyKey: `${runId}-initial-key` };
    const initialResponse = await as("adminA").post("/api/admin/non-catalog/balances/adjust").send(initial); expect(initialResponse.status, initialResponse.body.error).toBe(201);
    const adjustment = { itemId, locationId: locationA, quantityDelta: 5, reason: "ADJUSTMENT", idempotencyKey: `${runId}-adjustment-key` };
    expect((await as("adminA").post("/api/admin/non-catalog/balances/adjust").send(adjustment)).status).toBe(201);
    const replay = await as("adminA").post("/api/admin/non-catalog/balances/adjust").send(adjustment); expect(replay.status).toBe(200); expect(replay.body.duplicate).toBe(true);
    expect((await as("adminA").post("/api/admin/non-catalog/balances/adjust").send({ ...adjustment, quantityDelta: 6 })).status).toBe(409);
    const balance = await client.query("SELECT id,tenant_id,item_id,location_id,quantity_on_hand FROM non_catalog_inventory_balances WHERE tenant_id=$1 AND item_id=$2 AND location_id=$3", [tenantA, itemId, locationA]); expect(balance.rowCount).toBe(1); expect(balance.rows[0]).toMatchObject({ tenant_id: tenantA, item_id: itemId, location_id: locationA, quantity_on_hand: "15.000" });
    expect((await as("adminA").get("/api/admin/non-catalog/balances")).body.balances.some((row: { id: number }) => row.id === balance.rows[0].id)).toBe(true);
    expect((await as("adminA").get(`/api/admin/non-catalog/balances/${balance.rows[0].id}`)).status).toBe(200);
    const movement = await client.query("SELECT id,tenant_id,inventory_entity_type,non_catalog_item_id,location_id,movement_type,quantity_delta,pre_quantity,post_quantity,idempotency_key,actor_user_id FROM inventory_movements WHERE tenant_id=$1 AND idempotency_key=$2", [tenantA, adjustment.idempotencyKey]); expect(movement.rowCount).toBe(1); expect(movement.rows[0]).toMatchObject({ tenant_id: tenantA, inventory_entity_type: "non_catalog", non_catalog_item_id: itemId, location_id: locationA, movement_type: "adjustment_increase", quantity_delta: "5.000000000000", pre_quantity: "10.000000000000", post_quantity: "15.000000000000", idempotency_key: adjustment.idempotencyKey, actor_user_id: adminA });
    const audit = await client.query("SELECT actor_id,tenant_id,action,resource_id,metadata FROM audit_logs WHERE tenant_id=$1 AND action='inventory.movement_posted' AND resource_id=$2", [tenantA, String(movement.rows[0].id)]); expect(audit.rowCount).toBe(1); expect(audit.rows[0]).toMatchObject({ actor_id: adminA, tenant_id: tenantA, action: "inventory.movement_posted", resource_id: String(movement.rows[0].id) }); expect(audit.rows[0].metadata).toMatchObject({ itemId, locationId: locationA, movementType: "adjustment_increase" });
  });

  it("archives an item and then its now-empty section without deleting persisted history", async () => {
    const item = (await client.query("SELECT id,section_id FROM non_catalog_inventory_items WHERE tenant_id=$1 LIMIT 1", [tenantA])).rows[0];
    expect((await as("adminA").delete(`/api/admin/non-catalog/items/${item.id}`)).status).toBe(200);
    const archivedItem = await client.query("SELECT is_active FROM non_catalog_inventory_items WHERE id=$1", [item.id]); expect(archivedItem.rows[0].is_active).toBe(false);
    expect((await as("adminA").delete(`/api/admin/non-catalog/sections/${item.section_id}`)).status).toBe(200);
    const archivedSection = await client.query("SELECT is_active FROM non_catalog_inventory_sections WHERE id=$1", [item.section_id]); expect(archivedSection.rows[0].is_active).toBe(false);
  });
});
