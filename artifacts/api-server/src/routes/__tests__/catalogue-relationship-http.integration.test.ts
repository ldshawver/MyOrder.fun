/** Run with RUN_CATALOGUE_RELATIONSHIP_INTEGRATION=1 and a disposable localhost PostgreSQL clone. */
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_CATALOGUE_RELATIONSHIP_INTEGRATION === "1";
const authHeader = "x-catalogue-acceptance-user";
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header(authHeader) }),
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));

import productRouter from "../catalogue-products";
import legacyRouter from "../catalog";

const { Client } = pg;
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const identities = { a: `catalogue_guard_a_${suffix}`, b: `catalogue_guard_b_${suffix}` };
let client: pg.Client;
let tenantA: number; let tenantB: number; let locationA: number;
let separateA: { productId: number; optionId: number; catalogItemId: number; inventoryItemId: number };
let sharedA: typeof separateA;
let separateB: typeof separateA;

const app = express();
app.use(express.json());
app.use("/api", productRouter, legacyRouter);
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(500).json({ error: String(error) });
app.use(errorHandler);
const http = supertest(app);
const as = (identity: keyof typeof identities) => ({
  get: (path: string) => http.get(path).set(authHeader, identities[identity]),
  post: (path: string) => http.post(path).set(authHeader, identities[identity]),
  patch: (path: string) => http.patch(path).set(authHeader, identities[identity]),
  put: (path: string) => http.put(path).set(authHeader, identities[identity]),
});

async function databaseSnapshot(): Promise<string> {
  const result = await client.query(`SELECT jsonb_build_object(
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalogue_products t WHERE tenant_id IN ($1,$2)),
    'options',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalogue_options t WHERE tenant_id IN ($1,$2)),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_items t WHERE tenant_id IN ($1,$2)),
    'catalogue',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalog_items t WHERE tenant_id IN ($1,$2)),
    'balances',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_balances t WHERE tenant_id IN ($1,$2)),
    'reservations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_reservations t WHERE order_id IN (SELECT id FROM orders WHERE tenant_id IN ($1,$2))),
    'movements',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_movements t WHERE tenant_id IN ($1,$2)),
    'journal',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY transaction_id),'[]'::jsonb) FROM inventory_transaction_log t WHERE tenant_id IN ($1,$2)),
    'orders',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM orders t WHERE tenant_id IN ($1,$2)),
    'orderLines',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM order_items t WHERE order_id IN (SELECT id FROM orders WHERE tenant_id IN ($1,$2)))
  ) AS snapshot`, [tenantA, tenantB]);
  return JSON.stringify(result.rows[0].snapshot);
}

async function rejectedWithoutMutation(request: PromiseLike<supertest.Response>, expected: number | number[]) {
  const before = await databaseSnapshot();
  const response = await request;
  expect(Array.isArray(expected) ? expected : [expected]).toContain(response.status);
  expect(await databaseSnapshot()).toBe(before);
  return response;
}

async function createProduct(identity: keyof typeof identities, name: string, inventoryModel: "SHARED" | "SEPARATE_VARIANTS") {
  const response = await as(identity).post("/api/admin/catalogue/products")
    .send({ name, category: "Acceptance", price: "10.00", sku: `${name}-${suffix}`,
      inventoryModel, baseUnit: "each", consumptionQuantity: "1.000000" });
  expect(response.status, response.text).toBe(201);
  return response.body as typeof separateA;
}

(enabled ? describe : describe.skip)("catalogue relationship HTTP abuse on disposable PostgreSQL", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    const tenants = await client.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id,slug",
      [`Catalogue Guard A ${suffix}`, `catalogue-guard-a-${suffix}`, `Catalogue Guard B ${suffix}`, `catalogue-guard-b-${suffix}`]);
    tenantA = tenants.rows[0].id; tenantB = tenants.rows[1].id;
    await client.query("INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,approved_by_clerk_id,approved_at,is_active,identity_status,provisioning_status) VALUES($1,$2,$2,'admin',$3,'approved',$7,now(),true,'verified','active'),($4,$5,$5,'admin',$6,'approved',$7,now(),true,'verified','active')",
      [identities.a, `${identities.a}@example.test`, tenantA, identities.b, `${identities.b}@example.test`, tenantB, process.env.MYORDER_OWNER_CLERK_ID]);
    const location = await client.query("INSERT INTO inventory_locations(tenant_id,type,name,is_active) VALUES($1,'backstock',$2,true) RETURNING id", [tenantA, `Catalogue Guard ${suffix}`]);
    locationA = location.rows[0].id;
    separateA = await createProduct("a", `Separate A ${suffix}`, "SEPARATE_VARIANTS");
    sharedA = await createProduct("a", `Shared A ${suffix}`, "SHARED");
    separateB = await createProduct("b", `Separate B ${suffix}`, "SEPARATE_VARIANTS");
  }, 30_000);
  afterAll(async () => { if (client) await client.end(); });

  it("rejects unknown and mass-assigned relationship fields on create and legacy update", async () => {
    const valid = { name: "Injected", category: "Acceptance", price: "9.00" };
    for (const field of ["productId", "product_id", "optionId", "option_id", "inventoryItemId",
      "inventory_item_id", "tenantId", "tenant_id", "ownerId"]) {
      await rejectedWithoutMutation(as("a").post("/api/admin/catalogue/products").send({ ...valid, [field]: separateB.productId }), [400, 403]);
    }
    await rejectedWithoutMutation(as("a").post(`/api/admin/catalogue/products/${separateA.productId}/options`)
      .send({ label: "Bad", price: "10.00", consumptionQuantity: "1", productId: separateB.productId }), 400);
    await rejectedWithoutMutation(as("a").patch(`/api/catalog/${separateA.catalogItemId}`)
      .send({ inventoryItemId: separateB.inventoryItemId }), 400);
  });

  it("legacy catalogue create strips relationship injection and creates its own tenant-owned Standard option", async () => {
    const response = await as("a").post("/api/catalog").send({
      name: `Legacy Guard ${suffix}`, category: "Acceptance", price: 9,
      productId: separateB.productId, product_id: separateB.productId,
      optionId: separateB.optionId, inventoryItemId: separateB.inventoryItemId,
      inventory_item_id: separateB.inventoryItemId,
    });
    expect(response.status, response.text).toBe(201);
    const relation = await client.query(`SELECT co.tenant_id,co.product_id,co.inventory_item_id,co.label,
      ii.catalog_item_id AS inventory_catalog_item_id FROM catalogue_options co
      JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
      WHERE co.catalog_item_id=$1`, [response.body.id]);
    expect(relation.rows).toHaveLength(1);
    expect(relation.rows[0]).toMatchObject({ tenant_id: tenantA, label: "Standard",
      inventory_catalog_item_id: response.body.id });
    expect(relation.rows[0].product_id).not.toBe(separateB.productId);
    expect(relation.rows[0].inventory_item_id).not.toBe(separateB.inventoryItemId);
  });

  it("rejects cross-tenant product, option and inventory IDs without mutation", async () => {
    const listed = await as("a").get("/api/admin/catalogue/products");
    expect(listed.status).toBe(200);
    expect(listed.body.products.map((product: { id: number }) => product.id)).not.toContain(separateB.productId);
    await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/products/${separateB.productId}`).send({ name: "Stolen" }), 404);
    await rejectedWithoutMutation(as("a").post(`/api/admin/catalogue/products/${separateB.productId}/options`)
      .send({ label: "Stolen", price: "10.00", consumptionQuantity: "1" }), 404);
    await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/options/${separateB.optionId}`).send({ label: "Stolen" }), 404);
    await rejectedWithoutMutation(as("a").get(`/api/admin/catalogue/inventory/${separateB.inventoryItemId}/locations`), 404);
    await rejectedWithoutMutation(as("a").post(`/api/admin/catalogue/products/${sharedA.productId}/options`)
      .send({ label: "Bad", price: "10.00", consumptionQuantity: "1", inventoryItemId: separateB.inventoryItemId }), 409);
  });

  it("rejects update mass assignment, ownership changes and relationship changes", async () => {
    for (const payload of [{ unknown: true }, { tenantId: tenantB }, { tenant_id: tenantB },
      { inventoryItemId: separateB.inventoryItemId }, { productId: separateB.productId }]) {
      await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/products/${separateA.productId}`).send(payload), [400, 403]);
      await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/options/${separateA.optionId}`).send(payload), [400, 403, 409]);
    }
    await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/options/${separateA.optionId}`)
      .send({ inventoryItemId: separateB.inventoryItemId }), 409);
    await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/options/${separateA.optionId}`)
      .send({ inventoryItemId: sharedA.inventoryItemId }), 409);
  });

  it("keeps SHARED on one item and SEPARATE_VARIANTS on distinct own items", async () => {
    const shared = await as("a").post(`/api/admin/catalogue/products/${sharedA.productId}/options`)
      .send({ label: "Second", price: "12.00", consumptionQuantity: "2.000000" });
    expect(shared.status, shared.text).toBe(201);
    expect(shared.body.inventoryItemId).toBe(sharedA.inventoryItemId);
    await rejectedWithoutMutation(as("a").post(`/api/admin/catalogue/products/${sharedA.productId}/options`)
      .send({ label: "Injected", price: "12.00", consumptionQuantity: "2", inventoryItemId: separateA.inventoryItemId }), 409);
    const separate = await as("a").post(`/api/admin/catalogue/products/${separateA.productId}/options`)
      .send({ label: "Second", price: "12.00", consumptionQuantity: "1" });
    expect(separate.status, separate.text).toBe(201);
    expect(separate.body.inventoryItemId).not.toBe(separateA.inventoryItemId);
    await rejectedWithoutMutation(as("a").post(`/api/admin/catalogue/products/${separateA.productId}/options`)
      .send({ label: "Injected", price: "12.00", consumptionQuantity: "1", inventoryItemId: sharedA.inventoryItemId }), 409);
    const relations = await client.query("SELECT product_id,inventory_item_id,COUNT(*)::int AS options FROM catalogue_options WHERE tenant_id=$1 AND product_id IN ($2,$3) GROUP BY product_id,inventory_item_id ORDER BY product_id,inventory_item_id", [tenantA, sharedA.productId, separateA.productId]);
    expect(relations.rows.filter(row => row.product_id === sharedA.productId)).toHaveLength(1);
    expect(relations.rows.filter(row => row.product_id === separateA.productId)).toHaveLength(2);
  });

  it("safely switches an unused multi-variant product to SHARED and persists variant values after reload", async () => {
    const before = await as("a").get("/api/admin/catalogue/products");
    const original = before.body.products.find((candidate: { id: number }) => candidate.id === separateA.productId);
    expect(original.options).toHaveLength(2);
    const secondOption = original.options.find((option: { id: number }) => option.id !== separateA.optionId);
    const edited = await as("a").patch(`/api/admin/catalogue/options/${secondOption.id}`)
      .send({ price: "17.50", consumptionQuantity: "2.500000" });
    expect(edited.status, edited.text).toBe(200);
    const switched = await as("a").patch(`/api/admin/catalogue/products/${separateA.productId}`)
      .send({ inventoryModel: "SHARED" });
    expect(switched.status, switched.text).toBe(200);
    expect(switched.body.product.inventoryModel).toBe("SHARED");
    const reloaded = await as("a").get("/api/admin/catalogue/products");
    const product = reloaded.body.products.find((candidate: { id: number }) => candidate.id === separateA.productId);
    expect(product.inventoryModel).toBe("SHARED");
    expect(new Set(product.options.map((option: { inventoryItemId: number }) => option.inventoryItemId)).size).toBe(1);
    expect(product.options.find((option: { id: number }) => option.id === secondOption.id)).toMatchObject({
      price: "17.50", consumptionQuantity: "2.500000",
    });
    expect(2n * BigInt(String(edited.body.option.consumptionQuantity).replace(".", ""))).toBe(5000000n);
  });

  it("creates Color/Size variants with independent SKU, price, and inventory identities and prevents duplicate combinations", async () => {
    const created = await as("a").post("/api/admin/catalogue/products").send({
      name: "Variant axes " + suffix, category: "Acceptance", inventoryModel: "SEPARATE_VARIANTS", baseUnit: "each",
      variants: [
        { label: "Red / Small", optionValues: { Color: "Red", Size: "S" }, sku: "V-RS-" + suffix, price: "12.00", compareAtPrice: "15.00", consumptionQuantity: "1" },
        { label: "Blue / Large", optionValues: { Color: "Blue", Size: "L" }, sku: "V-BL-" + suffix, price: "14.00", consumptionQuantity: "1" },
      ],
    });
    expect(created.status, created.text).toBe(201);
    const [first, second] = created.body.options;
    expect(second.inventoryItemId).not.toBe(first.inventoryItemId);
    const duplicate = await rejectedWithoutMutation(as("a").post("/api/admin/catalogue/products/" + created.body.productId + "/options")
      .send({ label: "Red Small duplicate", optionValues: { Color: "Red", Size: "S" }, sku: "V-DUP-" + suffix, price: "99.00", consumptionQuantity: "1" }), 409);
    expect(duplicate.status).toBe(409);
    const stored = await client.query("SELECT co.id AS option_id,co.option_values,co.active,ci.sku,ci.price::text,ci.compare_at_price::text,co.inventory_item_id FROM catalogue_options co JOIN catalog_items ci ON ci.tenant_id=co.tenant_id AND ci.id=co.catalog_item_id WHERE co.tenant_id=$1 AND co.product_id=$2 AND co.id=ANY($3::int[]) ORDER BY co.id",
      [tenantA, created.body.productId, [first.optionId, second.optionId]]);
    expect(stored.rows).toEqual([
      { option_id: first.optionId, option_values: { Color: "Red", Size: "S" }, active: true,
        sku: "V-RS-" + suffix, price: "12.00", compare_at_price: "15.00", inventory_item_id: first.inventoryItemId },
      { option_id: second.optionId, option_values: { Color: "Blue", Size: "L" }, active: true,
        sku: "V-BL-" + suffix, price: "14.00", compare_at_price: null, inventory_item_id: second.inventoryItemId },
    ]);
    const disabled = await as("a").patch("/api/admin/catalogue/options/" + second.optionId).send({ active: false, isAvailable: false });
    expect(disabled.status, disabled.text).toBe(200);
    const disabledRow = await client.query("SELECT co.active,ci.is_available FROM catalogue_options co JOIN catalog_items ci ON ci.id=co.catalog_item_id WHERE co.tenant_id=$1 AND co.id=$2", [tenantA, second.optionId]);
    expect(disabledRow.rows[0]).toEqual({ active: false, is_available: false });
  });

  it("exercises the installed recorded-activity trigger through the authenticated HTTP model update", async () => {
    const active = await createProduct("a", `Activity ${suffix}`, "SEPARATE_VARIANTS");
    const balance = await as("a").put(`/api/admin/catalogue/inventory/${active.inventoryItemId}/locations/${locationA}/balance`)
      .send({ quantityOnHand: "5.000000" });
    expect(balance.status, balance.text).toBe(200);
    const recorded = await client.query("SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [tenantA, active.catalogItemId, locationA]);
    expect(recorded.rows[0]?.quantity).toBe("5.000000");
    const journal = await client.query("SELECT id FROM inventory_transaction_log WHERE tenant_id=$1 AND after_state->'balances' @> $2::jsonb",
      [tenantA, JSON.stringify([{ productId: active.catalogItemId }])]);
    expect(journal.rowCount).toBeGreaterThan(0);
    const response = await rejectedWithoutMutation(as("a").patch(`/api/admin/catalogue/products/${active.productId}`)
      .send({ inventoryModel: "SHARED" }), 409);
    expect(response.body.code).toBe("CONTROLLED_RECONCILIATION_REQUIRED");
    expect(response.body.error).toMatch(/inventory.*history|controlled reconciliation/i);
    const model = await client.query("SELECT inventory_model FROM catalogue_products WHERE id=$1", [active.productId]);
    expect(model.rows[0].inventory_model).toBe("SEPARATE_VARIANTS");
  });
});
