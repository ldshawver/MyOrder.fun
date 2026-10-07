/** Run against a disposable localhost PostgreSQL clone with RUN_COMPLIANCE_LIFECYCLE_INTEGRATION=1. */
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_COMPLIANCE_LIFECYCLE_INTEGRATION === "1";
const authHeader = "x-compliance-acceptance-user";
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header(authHeader) }),
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));

import catalogRouter from "../catalog";
import productsRouter from "../catalogue-products";

const { Client } = pg;
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const identities = { adminA: `compliance_admin_a_${suffix}`, supervisorA: `compliance_supervisor_a_${suffix}`,
  viewerA: `compliance_viewer_a_${suffix}`, tenantAdminA: `compliance_tenant_admin_a_${suffix}`,
  adminB: `compliance_admin_b_${suffix}` };
let client: pg.Client;
let tenantA: number;
const fixtureIds: number[] = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never; next(); });
app.use("/api", catalogRouter, productsRouter);
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(500).json({ error: String(error) });
app.use(errorHandler);
const http = supertest(app);
const as = (identity: keyof typeof identities) => ({
  get: (path: string) => http.get(path).set(authHeader, identities[identity]),
  post: (path: string) => http.post(path).set(authHeader, identities[identity]),
  patch: (path: string) => http.patch(path).set(authHeader, identities[identity]),
});

async function fixture(name: string, flags: { available: boolean; inStock: boolean; archived?: boolean }) {
  const created = await as("adminA").post("/api/catalog")
    .send({ name: `${name} ${suffix}`, category: "Acceptance", price: 9.5, taxable: true });
  expect(created.status, created.text).toBe(201);
  const id = Number(created.body.id);
  fixtureIds.push(id);
  await client.query("UPDATE catalog_items SET is_available=$1,alavont_in_stock=$2,metadata=$3::jsonb WHERE tenant_id=$4 AND id=$5",
    [flags.available, flags.inStock, JSON.stringify({ complianceHold: true,
      complianceReason: "Fixture review", complianceMatchedTerms: ["fixture"],
      ...(flags.archived ? { archived: true } : {}), unrelated: "preserve" }), tenantA, id]);
  return id;
}

async function row(id: number) {
  const result = await client.query(`SELECT to_jsonb(ci)-'metadata'-'updated_at' AS protected_fields,
    ci.metadata-'complianceHold'-'complianceReason'-'complianceMatchedTerms' AS unrelated_metadata,
    ci.metadata,ci.updated_at FROM catalog_items ci WHERE tenant_id=$1 AND id=$2`, [tenantA, id]);
  return result.rows[0] as { protected_fields: unknown; unrelated_metadata: unknown;
    metadata: Record<string, unknown>; updated_at: Date };
}

async function relatedState(): Promise<string> {
  const result = await client.query(`SELECT jsonb_build_object(
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalogue_products t WHERE tenant_id=$1),
    'options',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalogue_options t WHERE tenant_id=$1),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_items t WHERE tenant_id=$1),
    'balances',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_balances t WHERE tenant_id=$1),
    'reservations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_reservations t WHERE order_id IN (SELECT id FROM orders WHERE tenant_id=$1)),
    'movements',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_movements t WHERE tenant_id=$1),
    'reorder',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM inventory_reorder_policies t WHERE tenant_id=$1),
    'orders',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM orders t WHERE tenant_id=$1),
    'payments',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM payment_attempts t WHERE tenant_id=$1)
  ) AS snapshot`, [tenantA]);
  return JSON.stringify(result.rows[0].snapshot);
}

async function auditCount(id: number) {
  const result = await client.query("SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id=$1 AND action IN ('catalog.lifecycle_updated','catalog.compliance_hold_placed','catalog.compliance_hold_released') AND resource_id=$2", [tenantA, String(id)]);
  return result.rows[0].count as number;
}

(enabled ? describe : describe.skip)("compliance lifecycle on authenticated HTTP routes and disposable PostgreSQL", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    const tenants = await client.query("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id",
      [`Compliance A ${suffix}`, `compliance-a-${suffix}`, `Compliance B ${suffix}`, `compliance-b-${suffix}`]);
    tenantA = tenants.rows[0].id;
    const tenantB = tenants.rows[1].id as number;
    await client.query(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
      VALUES($1,$2,$2,'global_admin',$3,'approved',true,'verified','active'),
      ($4,$5,$5,'supervisor',$3,'approved',true,'verified','active'),
      ($6,$7,$7,'user',$3,'approved',true,'verified','active'),
      ($8,$9,$9,'admin',$3,'approved',true,'verified','active'),
      ($10,$11,$11,'admin',$12,'approved',true,'verified','active')`,
    [identities.adminA, `${identities.adminA}@example.test`, tenantA,
      identities.supervisorA, `${identities.supervisorA}@example.test`,
      identities.viewerA, `${identities.viewerA}@example.test`,
      identities.tenantAdminA, `${identities.tenantAdminA}@example.test`,
      identities.adminB, `${identities.adminB}@example.test`, tenantB]);
  }, 30_000);
  afterAll(async () => { if (client) await client.end(); });

  it.each([
    ["available in stock", { available: true, inStock: true }],
    ["available out of stock", { available: true, inStock: false }],
    ["independently unavailable", { available: false, inStock: true }],
    ["archived and held", { available: true, inStock: true, archived: true }],
  ] as const)("clears only compliance-owned metadata for %s", async (label, flags) => {
    const id = await fixture(label, flags);
    const before = await row(id);
    const relatedBefore = await relatedState();
    const auditsBefore = await auditCount(id);
    const response = await as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`)
      .send({ complianceHold: false, reason: "Administrative clearance" });
    expect(response.status, response.text).toBe(200);
    const after = await row(id);
    expect(after.protected_fields).toEqual(before.protected_fields);
    expect(after.unrelated_metadata).toEqual(before.unrelated_metadata);
    expect(after.metadata).toMatchObject({ complianceHold: false, complianceReason: null,
      complianceMatchedTerms: [], unrelated: "preserve" });
    expect(await relatedState()).toBe(relatedBefore);
    expect(await auditCount(id)).toBe(auditsBefore + 1);
    const repeated = await as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`)
      .send({ complianceHold: false, reason: "Administrative clearance" });
    expect(repeated.status).toBe(200);
    expect((await row(id)).updated_at).toEqual(after.updated_at);
    expect(await auditCount(id)).toBe(auditsBefore + 1);
    const products = await as("adminA").get("/api/catalogue/products");
    expect(products.status).toBe(200);
    const visible = products.body.products.some((product: { options: Array<{ catalogItemId: number }> }) =>
      product.options.some(option => option.catalogItemId === id));
    expect(visible).toBe(flags.available && flags.inStock && !('archived' in flags && flags.archived));
  });

  it("does not project an out-of-stock item without a hold as compliance-held", async () => {
    const id = fixtureIds[1];
    const master = await as("adminA").get("/api/admin/product-master");
    expect(master.status, master.text).toBe(200);
    const projected = master.body.rows.find((item: { id: number }) => item.id === id);
    expect(projected.lifecycle.complianceHold).toBe(false);
    expect(projected.lifecycle.nonSellable).toBe(true);
  });

  it("rejects unauthorized, cross-tenant and mass-assigned clear requests without mutation", async () => {
    const id = await fixture("authorization", { available: true, inStock: false });
    const before = await row(id);
    const audits = await auditCount(id);
    const requests = [
      http.patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review" }),
      as("viewerA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review" }),
      as("tenantAdminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review" }),
      as("tenantAdminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: true, reason: "Not a Global Admin" }),
      as("adminB").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review" }),
      as("supervisorA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: true, reason: "Supervisor cannot hold" }),
      as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review", inventoryItemId: 999 }),
      as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review", tenant_id: 999 }),
      as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review", isAvailable: true }),
      as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Review", alavontInStock: true }),
      as("adminA").patch(`/api/catalog/${id}`).send({ metadata: { complianceHold: false } }),
    ];
    for (const request of requests) {
      const response = await request;
      expect([400, 401, 403, 404]).toContain(response.status);
      expect(await row(id)).toEqual(before);
      expect(await auditCount(id)).toBe(audits);
    }
  });

  it("allows only Global Admin to place or release a product hold and propagates parent holds to every variant", async () => {
    const parentId = await fixture("variant-parent-hold", { available: true, inStock: true });
    const childId = await fixture("variant-child-hold", { available: true, inStock: true });
    await client.query("UPDATE catalog_items SET metadata=metadata || '{\"complianceHold\":false,\"complianceReason\":null,\"complianceMatchedTerms\":[]}'::jsonb WHERE tenant_id=$1 AND id=$2", [tenantA, parentId]);
    await client.query("UPDATE catalog_items SET metadata=metadata || '{\"complianceHold\":true,\"complianceReason\":\"Independent variant review\"}'::jsonb WHERE tenant_id=$1 AND id=$2", [tenantA, childId]);
    const relation = await client.query("SELECT product_id FROM catalogue_options WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantA, parentId]);
    const parentProductId = relation.rows[0].product_id as number;
    await client.query("UPDATE catalogue_options SET product_id=$1,option_values=$2::jsonb,label='Color: Blue' WHERE tenant_id=$3 AND catalog_item_id=$4",
      [parentProductId, JSON.stringify({ Color: "Blue" }), tenantA, childId]);
    const childProduct = await client.query("SELECT product_id FROM catalogue_options WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantA, childId]);
    await client.query("DELETE FROM catalogue_products WHERE tenant_id=$1 AND id=$2", [tenantA, childProduct.rows[0].product_id]);
    const placed = await as("adminA").patch(`/api/admin/product-master/${parentId}/lifecycle`)
      .send({ complianceHold: true, reason: "Safety review" });
    expect(placed.status, placed.text).toBe(200);
    const held = await client.query("SELECT id,metadata->>'complianceHold' AS held,metadata->>'complianceReason' AS reason FROM catalog_items WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id", [tenantA, [parentId, childId]]);
    expect(held.rows).toEqual([{ id: parentId, held: "true", reason: "Safety review" }, { id: childId, held: "true", reason: "Safety review" }]);
    const placementAudit = await client.query("SELECT action,tenant_id,actor_id,resource_id,metadata->>'reason' AS reason FROM audit_logs WHERE tenant_id=$1 AND resource_id=$2 AND action='catalog.compliance_hold_placed' ORDER BY id DESC LIMIT 1", [tenantA, String(parentId)]);
    expect(placementAudit.rows[0]).toMatchObject({ action: "catalog.compliance_hold_placed", tenant_id: tenantA,
      actor_id: expect.any(Number), resource_id: String(parentId), reason: "Safety review" });
    const visible = await as("adminA").get("/api/catalogue/products");
    expect(visible.body.products.some((product: { options: Array<{ catalogItemId: number }> }) =>
      product.options.some(option => option.catalogItemId === childId))).toBe(false);
    const released = await as("adminA").patch(`/api/admin/product-master/${parentId}/lifecycle`)
      .send({ complianceHold: false, reason: "Review cleared" });
    expect(released.status).toBe(200);
    const releaseAudit = await client.query("SELECT action,tenant_id,actor_id,resource_id,metadata->>'reason' AS reason FROM audit_logs WHERE tenant_id=$1 AND resource_id=$2 AND action='catalog.compliance_hold_released' ORDER BY id DESC LIMIT 1", [tenantA, String(parentId)]);
    expect(releaseAudit.rows[0]).toMatchObject({ action: "catalog.compliance_hold_released", tenant_id: tenantA,
      actor_id: expect.any(Number), resource_id: String(parentId), reason: "Review cleared" });
    expect(await auditCount(parentId)).toBeGreaterThan(0);
    const afterRelease = await client.query("SELECT id,metadata->>'complianceHold' AS held,is_available FROM catalog_items WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id", [tenantA, [parentId, childId]]);
    expect(afterRelease.rows).toEqual([{ id: parentId, held: "false", is_available: true }, { id: childId, held: "true", is_available: true }]);
    const childAfter = await row(childId);
    expect(childAfter.metadata.complianceReason).toBe("Independent variant review");
  });

  it("rejects malformed, nonexistent and invalid lifecycle requests without changing a held item or audit", async () => {
    const id = await fixture("invalid-paths", { available: true, inStock: false });
    const before = await row(id);
    const audits = await auditCount(id);
    const malformed = await as("adminA").patch("/api/admin/product-master/not-an-id/lifecycle").send({ complianceHold: false });
    const nonexistent = await as("adminA").patch("/api/admin/product-master/2147483647/lifecycle").send({ complianceHold: false, reason: "Review" });
    const invalid = await as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: "false" });
    const empty = await as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ reason: "missing state" });
    expect([malformed.status, nonexistent.status, invalid.status, empty.status]).toEqual([400, 404, 400, 400]);
    expect(await row(id)).toEqual(before);
    expect(await auditCount(id)).toBe(audits);
  });

  it("serializes concurrent clears so exactly one lifecycle audit accompanies the final state", async () => {
    const id = await fixture("concurrent", { available: false, inStock: false });
    const before = await row(id);
    const audits = await auditCount(id);
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Concurrent review" })));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    const after = await row(id);
    expect(after.protected_fields).toEqual(before.protected_fields);
    expect(after.metadata.complianceHold).toBe(false);
    expect(await auditCount(id)).toBe(audits + 1);
  });

  it("rolls back a lifecycle update when its audit insert fails", async () => {
    const id = await fixture("audit-rollback", { available: true, inStock: false });
    const before = await row(id);
    const audits = await auditCount(id);
    const trigger = `compliance_audit_fail_${suffix}`;
    await client.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('catalog.lifecycle_updated','catalog.compliance_hold_placed','catalog.compliance_hold_released') AND NEW.resource_id='${id}' THEN
        RAISE EXCEPTION 'isolated audit failure';
      END IF;
      RETURN NEW;
    END $$`);
    await client.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      const response = await as("adminA").patch(`/api/admin/product-master/${id}/lifecycle`).send({ complianceHold: false, reason: "Audit rollback test" });
      expect(response.status).toBe(500);
      expect(await row(id)).toEqual(before);
      expect(await auditCount(id)).toBe(audits);
    } finally {
      await client.query(`DROP TRIGGER ${trigger} ON audit_logs`);
      await client.query(`DROP FUNCTION ${trigger}()`);
    }
  });
});
