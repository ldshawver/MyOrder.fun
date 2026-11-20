/** PostgreSQL-backed security regression tests for staff guest-session creation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Actor = { id: number; role: string; email: string; tenantId: number };
const state = vi.hoisted(() => ({ actor: undefined as Actor | undefined, audits: [] as Array<Record<string, unknown>>, failSettlementOnce: false }));

vi.mock("../../lib/cashSettlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/cashSettlement")>();
  return {
    ...actual,
    settleCashOrder: async (...args: Parameters<typeof actual.settleCashOrder>) => {
      if (state.failSettlementOnce) {
        state.failSettlementOnce = false;
        throw new Error("guest_checkout_test_settlement_failure");
      }
      return actual.settleCashOrder(...args);
    },
  };
});

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as express.Request & { dbUser?: Actor }).dbUser = state.actor; next(); },
  requireDbUser: (req: express.Request, res: express.Response, next: express.NextFunction) => state.actor ? next() : res.status(401).json({ error: "Authentication required" }),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireCustomerCheckoutAccess: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  normalizeRole: (role: string) => role,
  writeAuditLog: vi.fn(async (entry: Record<string, unknown>) => { state.audits.push(entry); }),
}));
vi.mock("../../lib/tenantContext", () => ({
  requireTenantContext: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!state.actor) { res.status(401).json({ error: "Authentication required" }); return; }
    (req as express.Request & { authorizedTenantId?: number }).authorizedTenantId = state.actor.tenantId;
    next();
  },
}));

const databaseUrl = process.env.MYORDER_GUEST_TEST_DATABASE_URL;
const pgSuite = databaseUrl ? describe : describe.skip;

pgSuite("POST /guest-checkout/sessions (disposable PostgreSQL)", () => {
  let dbModule: typeof import("@workspace/db");
  let request: ReturnType<typeof supertest>;
  let tenantOne: number;
  let tenantTwo: number;
  let csrOne: Actor;
  let csrTwo: Actor;
  let inactiveCsr: Actor;
  let customer: Actor;
  let catalogItemId: number;
  let pickupLocationId: number;
  const disclaimerText = "Synthetic guest checkout confirmation";

  const payload = (key: string, displayName = "Guest Customer") => ({
    displayName,
    phone: "+15555550123",
    deliveryAddress: "1 Synthetic Lane",
    idempotencyKey: key,
  });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/^(127\.0\.0\.1|localhost|::1)$/.test(parsed.hostname) || !/^myorder_p0_owner_approval_guest_checkout_/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new Error("Refusing a non-disposable guest-checkout database");
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = "false";
    dbModule = await import("@workspace/db");
    const { db, pool, tenantsTable, usersTable, labTechShiftsTable, adminSettingsTable, catalogItemsTable, inventoryLocationsTable, inventoryBalancesTable, csrBoxesTable } = dbModule;
    await pool.query("TRUNCATE TABLE tenants RESTART IDENTITY CASCADE");
    const tenants = await db.insert(tenantsTable).values([
      { name: "Guest One", slug: "guest-one", status: "active" },
      { name: "Guest Two", slug: "guest-two", status: "active" },
    ]).returning();
    tenantOne = tenants[0]!.id; tenantTwo = tenants[1]!.id;
    const rows = await db.insert(usersTable).values([
      { clerkId: "guest-csr-one", email: "csr-one@example.invalid", role: "csr", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-csr-two", email: "csr-two@example.invalid", role: "csr", tenantId: tenantTwo, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-csr-inactive", email: "csr-inactive@example.invalid", role: "csr", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-customer", email: "customer@example.invalid", role: "user", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
    ]).returning();
    csrOne = { id: rows[0]!.id, role: "csr", email: rows[0]!.email!, tenantId: tenantOne };
    csrTwo = { id: rows[1]!.id, role: "csr", email: rows[1]!.email!, tenantId: tenantTwo };
    inactiveCsr = { id: rows[2]!.id, role: "csr", email: rows[2]!.email!, tenantId: tenantOne };
    customer = { id: rows[3]!.id, role: "user", email: rows[3]!.email!, tenantId: tenantOne };
    const [cashBox] = await db.insert(csrBoxesTable).values({ tenantId: tenantOne, slug: "sales-box-1", label: "Guest Test Box", isActive: true }).returning();
    await db.insert(labTechShiftsTable).values({ tenantId: tenantOne, techId: csrOne.id, status: "active", boxAssignmentId: "sales-box-1" });
    await db.insert(labTechShiftsTable).values({ tenantId: tenantTwo, techId: csrTwo.id, status: "active", boxAssignmentId: "guest-test-box" });
    await db.insert(adminSettingsTable).values({ tenantId: tenantOne, customerDisclaimerText: disclaimerText, customerDisclaimerVersion: 1, enabledProcessors: ["cash"], wcEnabled: false });
    await pool.query(`INSERT INTO tax_configurations(tenant_id,jurisdiction,rate,sourcing_rule,effective_from,source_name,source_url,verified_at,verified_by_user_id) VALUES($1,'Fixture',0.1,'tenant',CURRENT_DATE - 1,'fixture','https://example.invalid',now(),$2)`, [tenantOne, csrOne.id]);
    const [item] = await db.insert(catalogItemsTable).values({ tenantId: tenantOne, name: "Guest Fixture", description: "Fixture", category: "Menu", sku: "GUEST-FIXTURE", price: "20.00", stockQuantity: "3", inventoryAmount: "3", isAvailable: true, alavontName: "Guest Fixture", alavontDescription: "Fixture", alavontCategory: "Menu", alavontId: "GUEST-FIXTURE", alavontInStock: true, luciferCruzName: "Guest Fixture", luciferCruzDescription: "Fixture", luciferCruzCategory: "Menu", displayName: "Guest Fixture", customerSafeName: "Guest Fixture", customerSafeDescription: "Fixture", merchantName: "Guest Fixture", merchantDescription: "Fixture", merchantCategory: "Menu", merchantSku: "GUEST-FIXTURE", merchantBrand: "fixture", merchantProductSource: "local_mapped", merchantProcessingMode: "mapped_lucifer", receiptName: "Guest Fixture", labelName: "Guest Fixture", labName: "Guest Fixture" }).returning();
    catalogItemId = item!.id;
    const product = await pool.query<{ id: number }>("INSERT INTO catalogue_products(tenant_id,name,inventory_model,location_evaluation,active) VALUES($1,$2,'SEPARATE_VARIANTS','PER_LOCATION',true) RETURNING id", [tenantOne, item!.name]);
    const inventoryItem = await pool.query<{ id: number }>("INSERT INTO inventory_items(tenant_id,catalog_item_id,base_unit) VALUES($1,$2,'each') RETURNING id", [tenantOne, catalogItemId]);
    await pool.query("INSERT INTO catalogue_options(tenant_id,product_id,catalog_item_id,inventory_item_id,label,consumption_quantity,sort_order,active) VALUES($1,$2,$3,$4,'Standard',1,0,true)", [tenantOne, product.rows[0]!.id, catalogItemId, inventoryItem.rows[0]!.id]);
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId: tenantOne, type: "storefront", name: "Guest Front", displayOrder: 1, csrBoxId: cashBox!.id }).returning();
    pickupLocationId = location!.id;
    await db.insert(inventoryBalancesTable).values({ tenantId: tenantOne, productId: catalogItemId, locationId: pickupLocationId, quantityOnHand: "3", parLevel: "1" });
    await pool.query("INSERT INTO location_pickup_schedules(tenant_id,location_id,time_zone,weekly_hours,exceptions,slot_minutes,max_advance_days,version) VALUES($1,$2,'UTC',$3::jsonb,'[]'::jsonb,15,7,1)", [tenantOne, pickupLocationId, JSON.stringify(Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, intervals: [{ open: "00:00", close: "23:59" }] }))) ]);
    const { default: guestRouter } = await import("../guest-checkout");
    const { default: ordersRouter } = await import("../orders");
    const app = express();
    app.use(express.json());
    // This intentionally mounts the real order creation and closeout routes:
    // guest cash tests must exercise the same transaction as authenticated
    // checkout, not a route-local substitute.
    app.use("/api", guestRouter);
    app.use("/api", ordersRouter);
    request = supertest(app);
  }, 60_000);

  beforeEach(() => { state.actor = csrOne; state.audits.length = 0; state.failSettlementOnce = false; });
  afterAll(async () => { await dbModule.pool.end(); });

  const confirmation = () => ({ acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: disclaimerText });
  async function guestSession(key: string) {
    const response = await request.post("/api/guest-checkout/sessions").send(payload(key));
    expect(response.status, response.text).toBe(201);
    return response.body as { sessionId: number; capability: string };
  }
  async function guestCash(session: { sessionId: number; capability: string }, tender = "22.00", key = "guest-order-cash-key-0001") {
    const converted = await request.post("/api/cart/convert").send({ items: [{ catalogItemId, quantity: 1 }], confirmation: confirmation() });
    expect(converted.status, converted.text).toBe(200);
    const quote = await request.post("/api/checkout/quote").send({ items: [{ catalogItemId, quantity: 1 }], paymentMethod: "cash", deliveryMethod: "pickup", pickupLocationId });
    expect(quote.status, quote.text).toBe(200);
    return request.post("/api/guest-checkout/orders")
      .set("x-guest-checkout-session", String(session.sessionId))
      .set("x-guest-checkout-capability", session.capability)
      .set("x-cash-tender", tender)
      .set("x-guest-order-idempotency-key", key)
      .send({ items: [{ catalogItemId, quantity: 1 }], notes: "", checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, selectedPaymentMethod: "cash", paymentMethod: "cash", pickupLocationId, checkoutConfirmation: { ...confirmation(), paymentMethod: "cash", checkoutTaxQuoteToken: quote.body.checkoutTaxQuoteToken } });
  }

  it("serializes same-key concurrent requests and never discloses a capability on the replay", async () => {
    const key = "guest-session-concurrent-key-0001";
    const [left, right] = await Promise.all([
      request.post("/api/guest-checkout/sessions").send(payload(key)),
      request.post("/api/guest-checkout/sessions").send(payload(key)),
    ]);
    const winner = [left, right].find(response => response.status === 201);
    const replay = [left, right].find(response => response.status === 200);
    expect(winner?.body.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replay?.body).toMatchObject({ sessionId: winner?.body.sessionId, capabilityIssued: false });
    expect(replay?.body).not.toHaveProperty("capability");
    const { pool } = dbModule;
    const sessions = await pool.query("SELECT capability_hash FROM guest_checkout_sessions WHERE tenant_id = $1 AND staff_actor_user_id = $2 AND idempotency_key = $3", [tenantOne, csrOne.id, key]);
    const identities = await pool.query("SELECT id FROM guest_order_identities WHERE tenant_id = $1", [tenantOne]);
    expect(sessions.rowCount).toBe(1);
    expect(identities.rowCount).toBe(1);
    expect(sessions.rows[0]!.capability_hash).not.toBe(winner!.body.capability);
    expect(JSON.stringify(state.audits)).not.toContain(winner!.body.capability);
    expect(JSON.stringify(state.audits)).not.toContain("+15555550123");
  });

  it("returns 409 for a changed fingerprint and rolls back the losing guest identity", async () => {
    const key = "guest-session-conflict-key-0002";
    expect((await request.post("/api/guest-checkout/sessions").send(payload(key, "First Guest"))).status).toBe(201);
    const changed = await request.post("/api/guest-checkout/sessions").send(payload(key, "Other Guest"));
    expect(changed.status).toBe(409);
    const rows = await dbModule.pool.query("SELECT display_name FROM guest_order_identities WHERE tenant_id = $1", [tenantOne]);
    expect(rows.rows.map(row => row.display_name)).toEqual(expect.arrayContaining(["First Guest"]));
    expect(rows.rows.map(row => row.display_name)).not.toContain("Other Guest");
  });

  it("enforces tenant, role, active-shift, and strict input boundaries", async () => {
    state.actor = inactiveCsr;
    expect((await request.post("/api/guest-checkout/sessions").send(payload("guest-session-inactive-key-03"))).status).toBe(403);
    state.actor = customer;
    expect((await request.post("/api/guest-checkout/sessions").send(payload("guest-session-role-key-00004"))).status).toBe(403);
    state.actor = csrTwo;
    const secondTenant = await request.post("/api/guest-checkout/sessions").send(payload("guest-session-isolated-key-005"));
    expect(secondTenant.status).toBe(201);
    const otherTenantSession = await dbModule.pool.query("SELECT tenant_id FROM guest_checkout_sessions WHERE id = $1", [secondTenant.body.sessionId]);
    expect(otherTenantSession.rows[0]!.tenant_id).toBe(tenantTwo);
    state.actor = csrOne;
    expect((await request.post("/api/guest-checkout/sessions").send({ ...payload("guest-session-schema-key-006"), forbidden: true })).status).toBe(400);
  });

  it("uses the repository's conditional update: rollback restores it and replay is unavailable", async () => {
    const { db, guestCheckoutSessionsTable, guestOrderIdentitiesTable } = dbModule;
    const { createGuestToken } = await import("../../lib/guestTokens");
    const { consumeGuestCheckoutCapability } = await import("../../lib/guestCheckoutSessionRepository");
    const tracking = createGuestToken("tracking");
    const capability = createGuestToken("checkout");
    const [identity] = await db.insert(guestOrderIdentitiesTable).values({
      tenantId: tenantOne, createdByUserId: csrOne.id, displayName: "Rollback Guest", trackingTokenHash: tracking.digest,
      trackingExpiresAt: new Date(Date.now() + 60_000),
    }).returning({ id: guestOrderIdentitiesTable.id });
    const [session] = await db.insert(guestCheckoutSessionsTable).values({
      tenantId: tenantOne, guestIdentityId: identity!.id, staffActorUserId: csrOne.id, capabilityHash: capability.digest,
      expiresAt: new Date(Date.now() + 60_000), idempotencyKey: "guest-session-repository-key-007", requestFingerprint: "fixture-fingerprint",
    }).returning({ id: guestCheckoutSessionsTable.id });
    await expect(db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toMatchObject({ available: true });
      throw new Error("fixture rollback");
    })).rejects.toThrow("fixture rollback");
    await db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toMatchObject({ available: true });
    });
    await db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toEqual({ available: false });
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantTwo, actorId: csrOne.id, capabilityDigest: capability.digest })).toEqual({ available: false });
    });
  });

  it("settles an exact-tender guest pickup order through the shared transaction", async () => {
    const session = await guestSession("guest-cash-exact-session-key-001");
    const response = await guestCash(session, "20.00", "guest-cash-exact-order-key-001");
    expect(response.status, response.text).toBe(201);
    expect(response.body.paymentStatus).toBe("paid");
    const rows = await dbModule.pool.query("SELECT customer_id, guest_identity_id, payment_status, amount_tendered, change_given FROM orders WHERE id = $1", [response.body.id]);
    expect(rows.rows).toEqual([{ customer_id: null, guest_identity_id: expect.any(Number), payment_status: "paid", amount_tendered: "20.00", change_given: "0.00" }]);
    const ledger = await dbModule.pool.query("SELECT amount_tendered, change_given FROM cash_ledger_entries WHERE order_id = $1", [response.body.id]);
    expect(ledger.rows).toEqual([{ amount_tendered: "20.00", change_given: "0.00" }]);
  });

  it("records change due from the authoritative guest cash balance", async () => {
    const session = await guestSession("guest-cash-change-session-key-002");
    const response = await guestCash(session, "22.00", "guest-cash-change-order-key-002");
    expect(response.status, response.text).toBe(201);
    const ledger = await dbModule.pool.query("SELECT amount_tendered, change_given FROM cash_ledger_entries WHERE order_id = $1", [response.body.id]);
    expect(ledger.rows).toEqual([{ amount_tendered: "22.00", change_given: "2.00" }]);
  });

  it("rejects insufficient tender without consuming the guest capability or creating a cash sale", async () => {
    const session = await guestSession("guest-cash-insufficient-session-key-003");
    const response = await guestCash(session, "19.99", "guest-cash-insufficient-order-key-003");
    expect(response.status).toBe(422);
    const residue = await dbModule.pool.query(`SELECT
      (SELECT count(*) FROM orders WHERE guest_identity_id = (SELECT guest_identity_id FROM guest_checkout_sessions WHERE id = $1)) AS orders,
      (SELECT count(*) FROM cash_ledger_entries WHERE idempotency_key = $2) AS ledger,
      (SELECT consumed_at IS NULL FROM guest_checkout_sessions WHERE id = $1) AS unconsumed`, [session.sessionId, "guest-cash-insufficient-order-key-003"]);
    expect(residue.rows[0]).toEqual({ orders: "0", ledger: "0", unconsumed: true });
  });

  it("rolls back guest capability, order, inventory, cash, and effects when settlement throws", async () => {
    const session = await guestSession("guest-cash-forced-rollback-session-003a");
    state.failSettlementOnce = true;
    const response = await guestCash(session, "20.00", "guest-cash-forced-rollback-order-003a");
    expect(response.status).toBe(500);
    const residue = await dbModule.pool.query(`SELECT
      (SELECT count(*) FROM orders WHERE guest_identity_id = (SELECT guest_identity_id FROM guest_checkout_sessions WHERE id = $1)) AS orders,
      (SELECT consumed_at IS NULL FROM guest_checkout_sessions WHERE id = $1) AS unconsumed,
      (SELECT count(*) FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = $2)) AS reservations,
      (SELECT count(*) FROM inventory_movements WHERE tenant_id = $2) AS movements,
      (SELECT count(*) FROM payment_attempts WHERE tenant_id = $2) AS payments,
      (SELECT count(*) FROM cash_ledger_entries WHERE idempotency_key = $3) AS ledger,
      (SELECT count(*) FROM print_jobs WHERE tenant_id = $2) AS prints,
      (SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.tenant_id = $2) AS notifications`, [session.sessionId, tenantOne, "guest-cash-forced-rollback-order-003a"]);
    expect(residue.rows[0]).toEqual({ orders: "0", unconsumed: true, reservations: "0", movements: "0", payments: "0", ledger: "0", prints: "0", notifications: "0" });
    expect(state.audits).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: "CREATE_ORDER" })]));
  });

  it("fails closed for a foreign tenant capability", async () => {
    state.actor = csrTwo;
    const foreign = await guestSession("guest-cash-foreign-session-key-004");
    state.actor = csrOne;
    const response = await guestCash(foreign, "20.00", "guest-cash-foreign-order-key-004");
    expect(response.status).toBe(409);
    const residue = await dbModule.pool.query("SELECT count(*) FROM orders WHERE tenant_id = $1", [tenantOne]);
    // Earlier successful fixture cases are allowed; the foreign request adds none.
    expect(Number(residue.rows[0]!.count)).toBe(2);
  });

  it("rejects an inactive staff actor before creating a guest cash order", async () => {
    state.actor = inactiveCsr;
    const response = await request.post("/api/guest-checkout/orders")
      .set("x-guest-checkout-session", "1").set("x-guest-checkout-capability", "a".repeat(43))
      .set("x-cash-tender", "20.00").set("x-guest-order-idempotency-key", "guest-cash-inactive-order-key-005")
      .send({});
    expect(response.status).toBe(403);
  });
});
