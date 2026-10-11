/** Runs only against an explicitly named disposable, migrated PostgreSQL clone. */
import type { Server } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";

const people = vi.hoisted(() => ({
  customer: { clerkId: "tax_e2e_customer", email: "customer@tax-e2e.test", role: "user" },
  csr: { clerkId: "tax_e2e_csr", email: "csr@tax-e2e.test", role: "csr" },
  admin: { clerkId: "tax_e2e_admin", email: "admin@tax-e2e.test", role: "admin" },
  otherAdmin: { clerkId: "tax_e2e_other_admin", email: "other-admin@tax-e2e.test", role: "admin" },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: { header(name: string): string | undefined }) => {
    const person = people[req.header("x-tax-e2e-user") as keyof typeof people];
    return person ? { userId: person.clerkId, sessionClaims: { email: person.email, publicMetadata: { role: person.role, status: "approved" } } } : { userId: null, sessionClaims: {} };
  },
  clerkClient: { users: {
    getUser: vi.fn(async (clerkId: string) => {
      const person = Object.values(people).find(row => row.clerkId === clerkId);
      if (!person) throw new Error("Unknown test identity");
      return { id: clerkId, emailAddresses: [{ id: `email_${clerkId}`, emailAddress: person.email, verification: { status: "verified" } }], primaryEmailAddressId: `email_${clerkId}`, publicMetadata: { role: person.role, status: "approved" } };
    }),
    updateUser: vi.fn(), updateUserMetadata: vi.fn(), updateUserProfileImage: vi.fn(),
  } },
}));

import app from "../app";
import { adminSettingsTable, auditLogsTable, catalogItemsTable, cashLedgerEntriesTable, csrBoxesTable, customerCreditAccountsTable, customerCreditLedgerTable, customerDisclaimerAcceptancesTable, db, inventoryBalancesTable, inventoryLocationsTable, labTechShiftsTable, orderItemsTable, ordersTable, paymentAttemptsTable, paymentCapturesTable, paymentWebhookEventsTable, pool, taxConfigurationsTable, tenantSettingsTable, tenantsTable, uberDeliveryFulfillmentsTable, uberDeliveryQuotesTable, uberDirectSettingsTable, usersTable } from "@workspace/db";
import { PaymentService } from "../payments/service";
import { PayPalProvider, PayPalProviderError } from "../payments/paypal";
import { encrypt } from "../lib/crypto";
import { normalizeUberAddress } from "../lib/uberDirect";
import { dispatchPendingUberDelivery, reconcileUberDelivery, requestUberCancellation } from "../lib/uberFulfillment";
import { adjustCustomerCredit } from "../payments/customerCredit";
import { saveTenantPayPalSettings } from "../payments/tenantConfig";

const integrationDescribe = process.env.RUN_TENDER_TAX_INTEGRATION === "1" ? describe : describe.skip;
integrationDescribe("Cash tender tax via conversion, order, and closeout routes", () => {
  let server: Server | undefined;
  let request: ReturnType<typeof supertest>;
  let catalogItemId: number;
  let tenantId: number;
  let customerId: number;
  let csrId: number;
  let otherTenantId: number;
  let uberOrderId: number;
  const as = (who: keyof typeof people) => ({
    post: (path: string) => request.post(path).set("x-tax-e2e-user", who),
  });

  beforeAll(async () => {
    if (!/^postgresql:\/\/[^@]+@(?:127\.0\.0\.1|localhost):55432\/myorder_tax_final$/.test(process.env.DATABASE_URL ?? "")
      || process.env.TEST_DISPOSABLE_CLONE !== "I_UNDERSTAND_THIS_CLONE_IS_TRUNCATED") throw new Error("Explicit disposable tax clone required");
    const target = await db.execute(sql`SELECT current_database() AS name`);
    if (target.rows[0]?.name !== "myorder_tax_final") throw new Error("Disposable tax clone required");
    await db.execute(sql`TRUNCATE TABLE ${tenantsTable} RESTART IDENTITY CASCADE`);
    const [tenant] = await db.insert(tenantsTable).values({ name: "Tax E2E Tenant", slug: "tax-e2e-tenant", status: "active" }).returning();
    tenantId = tenant.id;
    await db.insert(adminSettingsTable).values({ tenantId: tenant.id, enabledProcessors: ["cash", "paypal"], orderRoutingRule: "round_robin", customerDisclaimerVersion: 1, customerDisclaimerText: "All sales are final. Confirm before checkout." });
    await saveTenantPayPalSettings(tenant.id, { enabled: true, environment: "sandbox", clientId: "synthetic-paypal-client", clientSecret: "synthetic-paypal-secret", webhookId: "synthetic-paypal-webhook" });
    const [otherTenant] = await db.insert(tenantsTable).values({ name: "Other Tax E2E Tenant", slug: "other-tax-e2e-tenant", status: "active" }).returning();
    otherTenantId = otherTenant.id;
    const [customer, csr] = await db.insert(usersTable).values([
      { clerkId: people.customer.clerkId, email: people.customer.email, normalizedEmail: people.customer.email, firstName: "Pat", lastName: "E2E", role: "user", tenantId: tenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.csr.clerkId, email: people.csr.email, normalizedEmail: people.csr.email, firstName: "Casey", lastName: "E2E", role: "csr", tenantId: tenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.admin.clerkId, email: people.admin.email, normalizedEmail: people.admin.email, firstName: "Ada", lastName: "E2E", role: "admin", tenantId: tenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.otherAdmin.clerkId, email: people.otherAdmin.email, normalizedEmail: people.otherAdmin.email, firstName: "Sam", lastName: "E2E", role: "admin", tenantId: otherTenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
    ]).returning();
    customerId = customer.id;
    csrId = csr.id;
    await db.insert(taxConfigurationsTable).values({ tenantId, jurisdiction: "Test", rate: "0.08750000", sourcingRule: "tenant", effectiveFrom: "2020-01-01", sourceName: "Test fixture", sourceUrl: "https://example.test/tax", verifiedAt: new Date(), verifiedByUserId: csr.id });
    await db.insert(customerDisclaimerAcceptancesTable).values({ tenantId: tenant.id, userId: customer.id, disclaimerVersion: 1 });
    const [box] = await db.insert(csrBoxesTable).values({ tenantId: tenant.id, slug: "sales-box-1", label: "CSR Sales Box 1", displayOrder: 1 }).returning();
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId: tenant.id, type: "csr_box", csrBoxId: box.id, name: "CSR Sales Box 1", displayOrder: 1 }).returning();
    await db.insert(labTechShiftsTable).values({ tenantId: tenant.id, techId: csr.id, status: "active", boxAssignmentId: box.slug, cashBankStart: "100.00", setupJson: { boxAssignmentId: box.slug, inventoryConfirmed: true, parLevelsConfirmed: true, printerAssigned: true } });
    const [item] = await db.insert(catalogItemsTable).values({ tenantId: tenant.id, name: "Taxable $100 Fixture", description: "Neutral test product", category: "Fixtures", sku: "TAX-E2E-100", price: "100.00", isTaxable: true, stockQuantity: "1000", inventoryAmount: "1000", isAvailable: true, alavontName: "Taxable $100 Fixture", alavontDescription: "Neutral test product", alavontCategory: "Fixtures", alavontId: "TAX-E2E-100", alavontInStock: true, luciferCruzName: "Taxable $100 Fixture", luciferCruzDescription: "Neutral test product", luciferCruzCategory: "Fixtures", displayName: "Taxable $100 Fixture", displayDescription: "Neutral test product", displayCategory: "Fixtures", merchantBrandName: "Lucifer Cruz", customerSafeName: "Taxable $100 Fixture", customerSafeDescription: "Neutral test product", merchantName: "Taxable $100 Fixture", merchantDescription: "Neutral test product", merchantCategory: "Fixtures", merchantSku: "TAX-E2E-100", merchantBrand: "alavont", merchantProductSource: "local_mapped", merchantProcessingMode: "mapped_lucifer", receiptName: "Taxable $100 Fixture", labelName: "Taxable $100 Fixture", labName: "Taxable $100 Fixture" }).returning();
    catalogItemId = item.id;
    await db.insert(inventoryBalancesTable).values({ tenantId: tenant.id, productId: item.id, locationId: location.id, quantityOnHand: "1000", parLevel: "2" });
    server = app.listen(0);
    request = supertest(server);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });

  it("keeps tenant PayPal secrets masked and refuses cross-environment or unpaired edits", async () => {
    const masked = await request.get("/api/admin/settings/paypal-status").set("x-tax-e2e-user", "admin");
    expect(masked.status).toBe(200);
    expect(masked.body).toMatchObject({ enabled: true, environment: "sandbox", clientIdConfigured: true, clientSecretConfigured: true, webhookIdConfigured: true });
    expect(JSON.stringify(masked.body)).not.toContain("synthetic-paypal-secret");
    const unpaired = await request.put("/api/admin/settings/paypal-status").set("x-tax-e2e-user", "admin").send({ clientId: "different-client" });
    expect(unpaired.status).toBe(409);
    const crossEnvironment = await request.put("/api/admin/settings/paypal-status").set("x-tax-e2e-user", "admin").send({ environment: "live" });
    expect(crossEnvironment.status).toBe(409);
    const retained = await request.put("/api/admin/settings/paypal-status").set("x-tax-e2e-user", "admin").send({ enabled: true });
    expect(retained.status).toBe(200);
    const publicConfig = await request.get("/api/payments/config").set("x-tax-e2e-user", "customer");
    expect(publicConfig.status).toBe(200);
    expect(publicConfig.body).toMatchObject({ enabled: true, mode: "sandbox", clientId: "synthetic-paypal-client" });
    expect(JSON.stringify(publicConfig.body)).not.toContain("synthetic-paypal-secret");
    const otherTenant = await request.get("/api/payments/config").set("x-tax-e2e-user", "otherAdmin");
    expect(otherTenant.status).toBe(200);
    expect(otherTenant.body.enabled).toBe(false);
  });

  it("provisions missing WooCommerce settings and isolates synthetic credentials across tenants", async () => {
    const key = "ck_synthetic_woo_complete_key_sentinel";
    const secret = "cs_synthetic_woo_secret_sentinel";
    await db.delete(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId));
    const missingRow = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId));
    expect(missingRow).toHaveLength(0);
    const provisioned = await request.get("/api/admin/settings/woocommerce").set("x-tax-e2e-user", "otherAdmin");
    expect(provisioned.status, provisioned.text).toBe(200);
    expect(JSON.stringify(provisioned.body)).not.toContain(secret);
    expect(await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId))).toHaveLength(1);
    const saved = await request.put("/api/admin/settings/woocommerce").set("x-tax-e2e-user", "otherAdmin")
      .send({ wcStoreUrl: "https://shop.example", wcConsumerKey: key, wcConsumerSecret: secret, enabled: true });
    expect(saved.status, saved.text).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(key);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const [stored] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId));
    expect(stored.wcConsumerKey).toMatch(/^enc:v1:/);
    expect(stored.wcConsumerSecret).toMatch(/^enc:v1:/);
    const crossQuery = await request.put(`/api/admin/settings/woocommerce?tenantId=${otherTenantId}`).set("x-tax-e2e-user", "admin").send({ wcConsumerSecret: "cs_wrong_tenant" });
    expect(crossQuery.status).toBe(403);
    const crossBody = await request.put("/api/admin/settings/woocommerce").set("x-tax-e2e-user", "admin").send({ tenantId: otherTenantId, wcConsumerSecret: "cs_wrong_tenant" });
    expect(crossBody.status).toBe(403);
    const unknown = await request.put("/api/admin/settings/woocommerce").set("x-tax-e2e-user", "otherAdmin").send({ wcConsumerSecret: "cs_wrong_tenant", extra: true });
    expect(unknown.status).toBe(400);
    const [unchanged] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId));
    expect(unchanged.wcConsumerSecret).toBe(stored.wcConsumerSecret);
    const removed = await request.put("/api/admin/settings/woocommerce").set("x-tax-e2e-user", "otherAdmin").send({ wcConsumerKey: "", wcConsumerSecret: "" });
    expect(removed.status, removed.text).toBe(200);
    const [cleared] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, otherTenantId));
    expect(cleared.wcConsumerKey).toBeNull();
    expect(cleared.wcConsumerSecret).toBeNull();
    const audits = await db.select().from(auditLogsTable).where(eq(auditLogsTable.tenantId, otherTenantId));
    expect(audits.filter(row => row.action === "settings.woocommerce.credentials_changed")).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain(key);
    expect(JSON.stringify(audits)).not.toContain(secret);
  }, 60_000);

  it("hides Uber quote, delivery, and order identities from another tenant", async () => {
    const quoteId = "test-tenant-a-quote";
    const address = { street_address: ["500 Test Street"], city: "Testville", state: "CA", zip_code: "94105", country: "US" };
    await db.insert(uberDeliveryQuotesTable).values({ id: quoteId, tenantId, customerId, providerQuoteId: "dqt_tenant_a", cartFingerprint: "test-fingerprint", pickupAddress: address, dropoffAddress: address, manifestItems: [{ name: "Test Item", quantity: 1 }], feeCents: 500, currency: "usd", expiresAt: new Date(Date.now() + 600_000) });
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", tax: "0.00", total: "105.00", paymentStatus: "paid", deliveryMethod: "uber_direct", deliveryQuoteId: quoteId, shippingAddress: "500 Test Street, Testville, CA 94105" }).returning();
    uberOrderId = order.id;
    await db.insert(uberDeliveryFulfillmentsTable).values({ tenantId, orderId: order.id, quoteId, externalOrderReference: `myorder-${tenantId}-${order.id}`, requestState: "delivery_create_pending" });
    const status = await request.get(`/api/orders/${order.id}/courier`).set("x-tax-e2e-user", "otherAdmin");
    const orderRead = await request.get(`/api/orders/${order.id}`).set("x-tax-e2e-user", "otherAdmin");
    const cancel = await request.post(`/api/orders/${order.id}/courier/cancel`).set("x-tax-e2e-user", "otherAdmin").send({});
    const reconcile = await request.post(`/api/admin/orders/${order.id}/courier/reconcile`).set("x-tax-e2e-user", "otherAdmin").send({});
    expect([status.status, orderRead.status, cancel.status, reconcile.status]).toEqual([404, 404, 404, 404]);
    const ownerStatus = await request.get(`/api/orders/${order.id}/courier`).set("x-tax-e2e-user", "customer");
    expect(ownerStatus.status).toBe(200);
    expect(JSON.stringify(ownerStatus.body)).not.toContain("dqt_tenant_a");
    expect(JSON.stringify(ownerStatus.body)).not.toContain(quoteId);
    const forged = await request.post(`/api/orders/${order.id}/courier/cancel`).set("x-tax-e2e-user", "customer").send({ providerDeliveryId: "del_tenant_b" });
    expect(forged.status).toBe(400);
    const [unchanged] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, order.id));
    expect(unchanged.requestState).toBe("delivery_create_pending");
  }, 60_000);

  it("authenticates Uber raw-body webhooks, rejects forgery and replay, and advances only forward", async () => {
    const signingKey = "synthetic-uber-webhook-key";
    await db.insert(uberDirectSettingsTable).values({ tenantId, enabled: true, environment: "sandbox", webhookSigningKeyCiphertext: encrypt(signingKey) });
    const externalId = `myorder-${tenantId}-${uberOrderId}`;
    const sendEvent = async (eventId: string, status: string, key = signingKey) => {
      const raw = Buffer.from(JSON.stringify({ id: eventId, event_type: "event.delivery_status", status, data: { id: "del_synthetic_tenant_a", external_id: externalId, status } }));
      const signature = createHmac("sha256", key).update(raw).digest("hex");
      return request.post("/api/webhooks/uber-direct").set("Content-Type", "application/json").set("x-uber-signature", signature).send(raw.toString("utf8"));
    };
    const forged = await sendEvent("evt-uber-forged", "delivered", "wrong-tenant-key");
    expect(forged.status, forged.text).toBe(401);
    const pending = await sendEvent("evt-uber-pending", "pending");
    expect(pending.status, pending.text).toBe(200);
    const pickup = await sendEvent("evt-uber-pickup", "pickup");
    expect(pickup.status, pickup.text).toBe(200);
    const stale = await sendEvent("evt-uber-stale", "pending");
    expect(stale.status).toBe(200);
    const replay = await sendEvent("evt-uber-pickup", "pickup");
    expect(replay.body.replayed).toBe(true);
    const [beforeDelivery] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, uberOrderId));
    expect(beforeDelivery.providerStatus).toBe("pickup");
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "canceling" }).where(eq(uberDeliveryFulfillmentsTable.orderId, uberOrderId));
    const duringCancel = await sendEvent("evt-uber-during-cancel", "pickup_complete");
    expect(duringCancel.status).toBe(200);
    const [inFlight] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, uberOrderId));
    expect(inFlight).toMatchObject({ providerStatus: "pickup_complete", requestState: "canceling" });
    const delivered = await sendEvent("evt-uber-delivered", "delivered");
    expect(delivered.status).toBe(200);
    const [afterDelivery] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, uberOrderId));
    expect(afterDelivery).toMatchObject({ providerDeliveryId: "del_synthetic_tenant_a", providerStatus: "delivered", requestState: "delivered" });
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, uberOrderId));
    expect(order.paymentStatus).toBe("paid");
  }, 60_000);

  it("quotes, accepts, pays, and dispatches Uber exactly once with a server-owned fee", async () => {
    const [storefront] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "storefront", name: "Synthetic Storefront", displayOrder: 3 }).returning();
    await db.insert(tenantSettingsTable).values({ tenantId, publicBusinessName: "Synthetic Shop", supportPhone: "+15555550111", businessAddressJson: { line1: "500 Test Street", city: "Testville", region: "CA", postalCode: "94105", country: "US" } }).onConflictDoUpdate({ target: tenantSettingsTable.tenantId, set: { publicBusinessName: "Synthetic Shop", supportPhone: "+15555550111", businessAddressJson: { line1: "500 Test Street", city: "Testville", region: "CA", postalCode: "94105", country: "US" } } });
    await db.update(usersTable).set({ contactPhone: "+15555550222" }).where(eq(usersTable.id, customerId));
    await db.update(uberDirectSettingsTable).set({ enabled: true, environment: "sandbox", customerId: "synthetic-uber-customer", clientId: "synthetic-uber-client", clientSecretCiphertext: encrypt("synthetic-uber-client-secret"), pickupLocationId: storefront.id, dispatchEnabled: true }).where(eq(uberDirectSettingsTable.tenantId, tenantId));
    const providerCalls: Array<{ url: string; body: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      providerCalls.push({ url, body });
      if (url.includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-uber-access-token", expires_in: 3600 }), { status: 200 });
      if (url.endsWith("/delivery_quotes")) return new Response(JSON.stringify({ id: `dqt_synthetic_${providerCalls.length}`, fee: 500, currency_type: "usd", expires: new Date(Date.now() + 600_000).toISOString() }), { status: 200 });
      if (url.endsWith("/cancel")) return new Response(JSON.stringify({ id: "del_synthetic_dispatched", status: "canceled" }), { status: 200 });
      if (url.endsWith("/deliveries")) return new Response(JSON.stringify({ id: "del_synthetic_dispatched", status: "pending" }), { status: 200 });
      throw new Error("Unexpected provider URL");
    });
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const address = "500 Test Street, Testville, CA 94105";
      const quote = await as("customer").post("/api/orders/delivery-quote").send({ items, dropoffAddress: address, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation });
      expect(quote.status, quote.text).toBe(200);
      expect(quote.body.feeCents).toBe(500);
      const [storedQuote] = await db.select().from(uberDeliveryQuotesTable).where(eq(uberDeliveryQuotesTable.id, quote.body.quoteId));
      expect(storedQuote).toBeDefined();
      expect(storedQuote.dropoffAddress).toEqual(normalizeUberAddress(address));
      expect(storedQuote.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "uber_direct", shippingAddress: address, deliveryQuote: { provider: "uber_direct", quoteId: quote.body.quoteId, feeCents: 1, fee: 0.01 } });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 113.75 });
      const orderId = Number(created.body.id);
      const beforePaid = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, orderId));
      expect(beforePaid).toHaveLength(1);
      expect(beforePaid[0].requestState).toBe("payment_pending");
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(0);
      const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "113.75", idempotencyKey: `uber-cash-${orderId}` });
      expect(closed.status, closed.text).toBe(200);
      expect(closed.body).toMatchObject({ tax: 8.75, total: 113.75, status: "confirmed", fulfillmentStatus: "submitted" });
      const replay = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "113.75", idempotencyKey: `uber-cash-${orderId}` });
      expect(replay.status, replay.text).toBe(200);
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(0);
      const [fulfillment] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, orderId));
      expect(fulfillment).toMatchObject({ providerDeliveryId: null, requestState: "awaiting_staff_request" });
      const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND movement_type = 'sale'`);
      expect(sales.rows).toHaveLength(1);
      const start = await as("csr").post(`/api/orders/${orderId}/fulfillment`).send({ fulfillmentStatus: "in_progress" });
      expect(start.status, start.text).toBe(200);
      const ready = await as("csr").post(`/api/orders/${orderId}/ready`).send({});
      expect(ready.status, ready.text).toBe(200);
      await db.update(uberDeliveryQuotesTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uberDeliveryQuotesTable.id, quote.body.quoteId));
      const dispatch = await as("csr").post(`/api/orders/${orderId}/courier/request`).send({});
      expect(dispatch.status, dispatch.text).toBe(200);
      expect(dispatch.body.state).toBe("delivery_created");
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(1);
      expect(providerCalls.filter(call => call.url.endsWith("/delivery_quotes"))).toHaveLength(2);
      expect(providerCalls.filter(call => call.url.includes("/payments/") || call.url.endsWith("/capture"))).toHaveLength(0);
      const [afterRequest] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, orderId));
      expect(afterRequest).toMatchObject({ providerDeliveryId: "del_synthetic_dispatched", requestState: "delivery_created" });
      expect(JSON.parse(providerCalls.find(call => call.url.endsWith("/deliveries"))!.body)).toMatchObject({ quote_id: expect.stringMatching(/^dqt_synthetic_/), external_id: `myorder-${tenantId}-${orderId}` });
      const duplicateDispatch = await as("csr").post(`/api/orders/${orderId}/courier/request`).send({});
      expect(duplicateDispatch.status).toBe(200);
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(1);
      const duplicateCheckout = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "uber_direct", shippingAddress: address, deliveryQuote: { provider: "uber_direct", quoteId: quote.body.quoteId, feeCents: 1 } });
      expect(duplicateCheckout.status).toBeGreaterThanOrEqual(400);
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(1);
      const freshConversion = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(freshConversion.status, freshConversion.text).toBe(200);
      const staleQuote = await as("customer").post("/api/orders/delivery-quote").send({ items, dropoffAddress: address, checkoutConversionToken: freshConversion.body.checkoutConversionToken, checkoutConversionSnapshot: freshConversion.body, checkoutConfirmation: confirmation });
      expect(staleQuote.status, staleQuote.text).toBe(200);
      await db.update(uberDeliveryQuotesTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uberDeliveryQuotesTable.id, staleQuote.body.quoteId));
      const expired = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: freshConversion.body.checkoutConversionToken, checkoutConversionSnapshot: freshConversion.body, checkoutConfirmation: confirmation, deliveryMethod: "uber_direct", shippingAddress: address, deliveryQuote: { provider: "uber_direct", quoteId: staleQuote.body.quoteId, feeCents: 1 } });
      expect(expired.status).toBe(422);
      expect(providerCalls.filter(call => call.url.endsWith("/deliveries"))).toHaveLength(1);
      const cancel = await as("customer").post(`/api/orders/${orderId}/courier/cancel`).send({});
      expect(cancel.status, cancel.text).toBe(202);
      expect(cancel.body).toMatchObject({ state: "canceled", paymentResolutionRequired: true });
      const cancelReplay = await as("customer").post(`/api/orders/${orderId}/courier/cancel`).send({});
      expect(cancelReplay.status).toBe(202);
      expect(providerCalls.filter(call => call.url.endsWith("/cancel"))).toHaveLength(1);
      const [afterCancel] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(afterCancel).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "reconciliation_required" });
    } finally { fetchSpy.mockRestore(); }
  }, 60_000);

  it("reconciles ambiguous Uber creation without a second dispatch and flags an expired paid quote", async () => {
    const address = normalizeUberAddress("500 Test Street, Testville, CA 94105");
    let settlementFixture = 0;
    const insertPaid = async (localQuoteId: string, providerQuoteId: string, expiresAt: Date) => {
      await db.insert(uberDeliveryQuotesTable).values({ id: localQuoteId, tenantId, customerId, providerQuoteId, cartFingerprint: "synthetic-recovery", pickupAddress: address, dropoffAddress: address, manifestItems: [{ name: "Test Item", quantity: 1 }], feeCents: 500, currency: "USD", expiresAt });
      const now = new Date();
      const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", tax: "0.00", total: "105.00", paymentStatus: "paid", paymentMethod: "paypal", customerCreditApplied: "0.00", deliveryMethod: "uber_direct", deliveryFee: "5.00", deliveryCurrency: "USD", deliveryQuoteId: localQuoteId, fulfillmentStatus: "ready", status: "ready", readyAt: now }).returning();
      const [attempt] = await db.insert(paymentAttemptsTable).values({ tenantId, orderId: order.id, provider: "paypal", providerEnvironment: "sandbox", providerOrderId: `PP_FIXTURE_${++settlementFixture}`, idempotencyKey: `uber-recovery-${settlementFixture}`, requestedAmount: "105.00", requestedCurrency: "USD", state: "captured", capturedAmount: "105.00", capturedCurrency: "USD" }).returning();
      await db.insert(paymentCapturesTable).values({ tenantId, paymentAttemptId: attempt.id, provider: "paypal", providerEnvironment: "sandbox", providerCaptureId: `CAP_FIXTURE_${settlementFixture}`, amount: "105.00", currency: "USD", state: "completed", capturedAt: now });
      await db.insert(uberDeliveryFulfillmentsTable).values({ tenantId, orderId: order.id, quoteId: localQuoteId, externalOrderReference: `myorder-${tenantId}-${order.id}`, requestState: "delivery_create_pending" });
      return order.id;
    };
    const ambiguousOrderId = await insertPaid("test-ambiguous-quote", "dqt_ambiguous", new Date(Date.now() + 600_000));
    const expiredOrderId = await insertPaid("test-expired-paid-quote", "dqt_expired", new Date(Date.now() - 1000));
    let createCalls = 0;
    let cancelLookupStatus = "pending";
    let cancelRaceOrderId = 0;
    let boundedOrderId = 0;
    let boundedLookupCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-recovery-token", expires_in: 3600 }), { status: 200 });
      if (url.includes("/deliveries?") && boundedOrderId && url.includes("offset=")) {
        const offset = Number(new URL(url).searchParams.get("offset"));
        if (offset < 5) {
          boundedLookupCalls += 1;
          return new Response(JSON.stringify({ data: offset === 0
            ? [{ id: "del_bounded", external_id: `myorder-${tenantId}-${boundedOrderId}`, quote_id: "dqt_bounded", status: "pending" }]
            : [{ id: `del_other_${offset}`, external_id: `other-${offset}`, quote_id: "dqt_other", status: "pending" }], next_href: "next" }), { status: 200 });
        }
      }
      if (url.includes("/deliveries?")) return new Response(JSON.stringify({ data: [{ id: "del_recovered", external_id: `myorder-${tenantId}-${ambiguousOrderId}`, quote_id: "dqt_ambiguous", status: "pending" }], next_href: null }), { status: 200 });
      if (url.endsWith("/deliveries/del_cancel_race")) return new Response(JSON.stringify({ id: "del_cancel_race", external_id: `myorder-${tenantId}-${cancelRaceOrderId}`, status: cancelLookupStatus }), { status: 200 });
      if (url.endsWith("/deliveries/del_identity_mismatch")) return new Response(JSON.stringify({ id: "del_identity_mismatch", external_id: "myorder-other-tenant-order", quote_id: "dqt_wrong", status: "pending" }), { status: 200 });
      if (url.endsWith("/deliveries/del_pending_cancel/cancel")) return new Response(JSON.stringify({ id: "del_pending_cancel", status: "pending" }), { status: 200 });
      if (url.endsWith("/deliveries/del_pending_cancel")) return new Response(JSON.stringify({ id: "del_pending_cancel", external_id: `myorder-${tenantId}-${pendingCancelOrderId}`, status: "canceled" }), { status: 200 });
      if (url.endsWith("/deliveries") && init?.method === "POST") { createCalls += 1; throw new Error("synthetic timeout after send"); }
      throw new Error("Unexpected provider URL");
    });
    let pendingCancelOrderId = 0;
    try {
      await dispatchPendingUberDelivery(tenantId, ambiguousOrderId);
      const [unresolved] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, ambiguousOrderId));
      expect(unresolved).toMatchObject({ requestState: "reconciliation_required", providerDeliveryId: null });
      expect(await Promise.all([
        reconcileUberDelivery(tenantId, ambiguousOrderId),
        reconcileUberDelivery(tenantId, ambiguousOrderId),
      ])).toEqual(["delivery_created", "delivery_created"]);
      await dispatchPendingUberDelivery(tenantId, ambiguousOrderId);
      expect(createCalls).toBe(1);
      const [recovered] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, ambiguousOrderId));
      expect(recovered).toMatchObject({ providerDeliveryId: "del_recovered", requestState: "delivery_created" });
      await dispatchPendingUberDelivery(tenantId, expiredOrderId);
      expect(createCalls).toBe(1);
      const [expired] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, expiredOrderId));
      const [paid] = await db.select().from(ordersTable).where(eq(ordersTable.id, expiredOrderId));
      expect(expired.requestState).toBe("requote_required");
      expect(paid).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "reconciliation_required" });

      const missingOrderId = await insertPaid("test-provider-missing-quote", "dqt_missing", new Date(Date.now() + 600_000));
      await dispatchPendingUberDelivery(tenantId, missingOrderId);
      expect(createCalls).toBe(2);
      expect(await reconcileUberDelivery(tenantId, missingOrderId)).toBe("manual_reconciliation_required");
      const [missing] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, missingOrderId));
      expect(missing).toMatchObject({ requestState: "manual_reconciliation_required", providerDeliveryId: null });
      await dispatchPendingUberDelivery(tenantId, missingOrderId);
      expect(createCalls).toBe(2);
      const [missingPaid] = await db.select().from(ordersTable).where(eq(ordersTable.id, missingOrderId));
      expect(missingPaid).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "reconciliation_required" });

      cancelRaceOrderId = await insertPaid("test-cancel-race-quote", "dqt_cancel_race", new Date(Date.now() + 600_000));
      await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "canceling", providerDeliveryId: "del_cancel_race" })
        .where(eq(uberDeliveryFulfillmentsTable.orderId, cancelRaceOrderId));
      expect(await reconcileUberDelivery(tenantId, cancelRaceOrderId)).toBe("canceling");
      const [stillCanceling] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, cancelRaceOrderId));
      expect(stillCanceling.requestState).toBe("canceling");
      cancelLookupStatus = "canceled";
      expect(await reconcileUberDelivery(tenantId, cancelRaceOrderId)).toBe("canceled");
      const [canceled] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, cancelRaceOrderId));
      expect(canceled).toMatchObject({ requestState: "canceled", providerStatus: "canceled" });

      const identityOrderId = await insertPaid("test-identity-quote", "dqt_identity", new Date(Date.now() + 600_000));
      await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "reconciliation_required", providerDeliveryId: "del_identity_mismatch" })
        .where(eq(uberDeliveryFulfillmentsTable.orderId, identityOrderId));
      expect(await reconcileUberDelivery(tenantId, identityOrderId)).toBe("manual_reconciliation_required");
      const [identity] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, identityOrderId));
      expect(identity).toMatchObject({ requestState: "manual_reconciliation_required", lastSanitizedError: "provider_identity_mismatch" });

      boundedOrderId = await insertPaid("test-bounded-quote", "dqt_bounded", new Date(Date.now() + 600_000));
      await dispatchPendingUberDelivery(tenantId, boundedOrderId);
      expect(await reconcileUberDelivery(tenantId, boundedOrderId)).toBe("manual_reconciliation_required");
      expect(boundedLookupCalls).toBe(5);
      const [bounded] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, boundedOrderId));
      expect(bounded).toMatchObject({ providerDeliveryId: null, requestState: "manual_reconciliation_required", lastSanitizedError: "bounded_lookup_incomplete" });
      await dispatchPendingUberDelivery(tenantId, boundedOrderId);
      expect(createCalls).toBe(3);

      pendingCancelOrderId = await insertPaid("test-pending-cancel-quote", "dqt_pending_cancel", new Date(Date.now() + 600_000));
      await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "delivery_created", providerDeliveryId: "del_pending_cancel", providerStatus: "pending" })
        .where(eq(uberDeliveryFulfillmentsTable.orderId, pendingCancelOrderId));
      expect(await requestUberCancellation(tenantId, pendingCancelOrderId)).toBe("cancel_reconciliation_required");
      const [pendingCancel] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, pendingCancelOrderId));
      expect(pendingCancel).toMatchObject({ requestState: "cancel_reconciliation_required", lastSanitizedError: "cancel_status_unconfirmed" });
      expect(await reconcileUberDelivery(tenantId, pendingCancelOrderId)).toBe("canceled");
    } finally { fetchSpy.mockRestore(); }
  }, 60_000);

  it("settles a taxable $100 Cash order with tax calculated once", async () => {
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const hostile = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup", tax: 0.01, total: 0.01 });
    expect(hostile.status).toBeGreaterThanOrEqual(400);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75 });
    const orderId = Number(created.body.id);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    expect(order).toMatchObject({ subtotal: "100.00", tax: "8.75", total: "108.75", remainingTenderAmount: "108.75" });
    const initialSnapshot = await db.execute(sql`SELECT tax_collected, tender, snapshot_json FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
    expect(initialSnapshot.rows).toHaveLength(1);
    expect(initialSnapshot.rows[0]).toMatchObject({ tax_collected: "8.75", tender: "cash" });
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "108.75", idempotencyKey: `tax-e2e-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75 });
    const ledger = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.orderId, orderId), eq(cashLedgerEntriesTable.tenantId, order.tenantId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe("108.75");
    const replay = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "108.75", idempotencyKey: `tax-e2e-${orderId}` });
    expect(replay.status, replay.text).toBe(200);
    expect(await db.select().from(cashLedgerEntriesTable).where(eq(cashLedgerEntriesTable.orderId, orderId))).toHaveLength(1);
    const finalSnapshot = await db.execute(sql`SELECT tax_collected, tender, snapshot_json FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
    expect(finalSnapshot.rows).toEqual(initialSnapshot.rows);
    const [orderLine] = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId)).limit(1);
    const returned = await as("admin").post(`/api/orders/${orderId}/returns`).send({ lines: [{ orderItemId: orderLine.id, quantity: 1, disposition: "DO_NOT_RESTOCK" }], reason: "Tax refund validation", idempotencyKey: `return:cash-tax-${orderId}` });
    expect(returned.status, returned.text).toBe(200);
    expect(returned.body).toMatchObject({ status: "completed", refundAmount: "108.75", taxAmount: "8.75", tenderType: "cash" });
    const refundedSnapshot = await db.execute(sql`SELECT tax_collected, tax_refunded FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
    expect(refundedSnapshot.rows[0]).toMatchObject({ tax_collected: "8.75", tax_refunded: "0.00" });
    const refundTax = await db.execute(sql`SELECT tax_amount FROM return_transactions WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND status = 'completed'`);
    expect(refundTax.rows[0]).toMatchObject({ tax_amount: "8.75" });
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND movement_type = 'sale'`);
    expect(sales.rows).toHaveLength(1);
  }, 60_000);

  it("applies the configured cash discount before calculating tax", async () => {
    await db.update(adminSettingsTable).set({ cashDiscountEnabled: true, cashDiscountType: "fixed", cashDiscountValue: "5.00" }).where(eq(adminSettingsTable.tenantId, tenantId));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 95, tax: 8.31, total: 103.31 });
      const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id)));
      expect(stored.taxSnapshot).toMatchObject({ taxableSubtotal: 95, discounts: 5, taxCollected: 8.31, exemptionReason: null });
    } finally {
      await db.update(adminSettingsTable).set({ cashDiscountEnabled: false, cashDiscountValue: "0.00" }).where(eq(adminSettingsTable.tenantId, tenantId));
    }
  }, 60_000);

  it("exempts non-taxable merchandise regardless of cash tender", async () => {
    await db.update(catalogItemsTable).set({ isTaxable: false }).where(eq(catalogItemsTable.id, catalogItemId));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 100, tax: 0, total: 100 });
      const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id)));
      expect(stored.taxSnapshot).toMatchObject({ taxableSubtotal: 0, taxCollected: 0, exemptionReason: "no_taxable_merchandise" });
    } finally {
      await db.update(catalogItemsTable).set({ isTaxable: true }).where(eq(catalogItemsTable.id, catalogItemId));
    }
  }, 60_000);

  it("pays a taxable $100 cart with Customer Credit including transaction tax", async () => {
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 10875, reason: "Disposable tax test fixture", idempotencyKey: "tax-e2e-credit-funding" }));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "customer_credit", customerCreditAmount: 108.75 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id))).limit(1);
    expect(stored).toMatchObject({ subtotal: "100.00", tax: "8.75", total: "108.75", customerCreditApplied: "108.75", remainingTenderAmount: "0.00", paymentStatus: "paid" });
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${stored.id} AND movement_type = 'sale'`);
    expect(sales.rows).toHaveLength(1);
  }, 60_000);

  it("returns the persisted credit and PayPal balance for a split checkout", async () => {
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 4000, reason: "Disposable split test fixture", idempotencyKey: "tax-e2e-split-credit-funding" }));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "paypal", customerCreditAmount: 40 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id)));
    expect(stored).toMatchObject({ subtotal: "100.00", tax: "8.75", total: "108.75", customerCreditApplied: "40.00", remainingTenderAmount: "68.75", paymentStatus: "unpaid" });
    expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75, customerCreditApplied: 40, remainingTenderAmount: 68.75, paymentStatus: "unpaid" });
    const cancelled = await as("admin").post(`/api/orders/${created.body.id}/cancel`).send({ reason: "Disposable split cancellation" });
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", customerCreditApplied: 0 });
    const replay = await as("admin").post(`/api/orders/${created.body.id}/cancel`).send({ reason: "Disposable split cancellation retry" });
    expect(replay.status, replay.text).toBe(200);
    const [account] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
    expect(account.reservedBalance).toBe("0.00");
    const creditEntries = await db.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, tenantId), eq(customerCreditLedgerTable.orderId, Number(created.body.id))));
    expect(creditEntries.map(entry => entry.entryType).sort()).toEqual(["order_reservation", "reservation_release"]);
  }, 60_000);

  it("routes public PayPal webhooks to signature verification", async () => {
    const response = await request.post("/api/webhooks/paypal")
      .set("Content-Type", "application/json")
      .send({ id: "synthetic-unsigned-event", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "synthetic-capture" } });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("MISSING_WEBHOOK_SIGNATURE");
  });

  it("selects PayPal webhook verification by existing tenant provider identity and deduplicates replay", async () => {
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "1.00", grossSubtotal: "1.00", taxableSubtotal: "1.00", tax: "0.09", total: "1.09", remainingTenderAmount: "1.09", selectedPaymentMethod: "paypal", checkoutConversionSnapshot: {}, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() }).returning();
    const providerOrderId = `TEST-TENANT-WEBHOOK-${order.id}`;
    await db.insert(paymentAttemptsTable).values({ tenantId, orderId: order.id, provider: "paypal", providerEnvironment: "sandbox", providerOrderId, idempotencyKey: `tenant-webhook-${order.id}`, requestedAmount: "1.09", requestedCurrency: "USD", state: "created" });
    const verify = vi.spyOn(PayPalProvider.prototype, "verifyWebhook").mockResolvedValue(true);
    const event = { id: `TEST-TENANT-WEBHOOK-EVENT-${order.id}`, event_type: "PAYMENT.CAPTURE.PENDING", resource: { id: providerOrderId } };
    const send = (value: typeof event) => request.post("/api/webhooks/paypal")
      .set("Content-Type", "application/json")
      .set("PayPal-Transmission-Id", "synthetic-transmission")
      .set("PayPal-Transmission-Time", new Date().toISOString())
      .set("PayPal-Transmission-Sig", "synthetic-signature")
      .set("PayPal-Cert-Url", "https://example.test/cert")
      .set("PayPal-Auth-Algo", "SHA256withRSA").send(value);
    try {
      const first = await send(event);
      expect(first.status, first.text).toBe(200);
      expect(first.body.replayed).toBe(false);
      const replay = await send(event);
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(verify).toHaveBeenCalledTimes(2);
      const unknown = await send({ ...event, id: `${event.id}-UNKNOWN`, resource: { id: "TEST-UNKNOWN-PROVIDER-ORDER" } });
      expect(unknown.status).toBe(400);
      // Unknown external identities are rejected before verification and are
      // not persisted as trusted webhook events.
      expect(verify).toHaveBeenCalledTimes(2);
      const events = await db.select().from(paymentWebhookEventsTable).where(eq(paymentWebhookEventsTable.providerEventId, event.id));
      expect(events).toHaveLength(1);
      const unknownEvent = await db.select().from(paymentWebhookEventsTable).where(eq(paymentWebhookEventsTable.providerEventId, `${event.id}-UNKNOWN`));
      expect(unknownEvent).toHaveLength(0);
    } finally { verify.mockRestore(); }
  }, 60_000);

  it("does not regress a captured PayPal attempt on a delayed approval webhook", async () => {
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "1.00", tax: "0.09", total: "1.09" }).returning();
    const providerOrderId = `TEST-LATE-APPROVAL-${order.id}`;
    const [attempt] = await db.insert(paymentAttemptsTable).values({ tenantId, orderId: order.id, provider: "paypal", providerEnvironment: "sandbox", providerOrderId, idempotencyKey: `late-approval-${order.id}`, requestedAmount: "1.09", requestedCurrency: "USD", state: "captured" }).returning();
    const verify = vi.spyOn(PayPalProvider.prototype, "verifyWebhook").mockResolvedValue(true);
    const getOrder = vi.spyOn(PayPalProvider.prototype, "getOrder").mockResolvedValue({ id: providerOrderId, status: "COMPLETED", amount: { value: "1.09", currency: "USD" } });
    try {
      const response = await request.post("/api/webhooks/paypal")
        .set("PayPal-Transmission-Id", "synthetic-transmission")
        .set("PayPal-Transmission-Time", new Date().toISOString())
        .set("PayPal-Transmission-Sig", "synthetic-signature")
        .set("PayPal-Cert-Url", "https://example.test/cert")
        .set("PayPal-Auth-Algo", "SHA256withRSA")
        .send({ id: `TEST-LATE-APPROVAL-EVENT-${order.id}`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: providerOrderId } });
      expect(response.status, response.text).toBe(200);
      const [after] = await db.select({ state: paymentAttemptsTable.state }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.id, attempt.id));
      expect(after.state).toBe("captured");
    } finally { verify.mockRestore(); getOrder.mockRestore(); }
  }, 60_000);

  it("serializes duplicate checkout submissions for one verified conversion", async () => {
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const body = { orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" };
    const [first, second] = await Promise.all([as("customer").post("/api/orders").send(body), as("customer").post("/api/orders").send(body)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.id).toBe(second.body.id);
    const replay = await as("customer").post("/api/orders").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const changed = await as("customer").post("/api/orders").send({ ...body, checkoutConfirmation: { ...confirmation, paymentMethod: "paypal" } });
    expect(changed.status).toBe(409);
    const sameToken = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id=${tenantId} AND customer_id=${customerId} AND checkout_conversion_snapshot->>'checkoutConversionToken'=${converted.body.checkoutConversionToken}`);
    expect(sameToken.rows[0]?.n).toBe(1);
  }, 60_000);

  it("authoritatively allocates PayPal tax after Customer Credit and replays without a second provider order", async () => {
    const provider = { createOrder: vi.fn(async ({ amount }: { amount: { value: string; currency: string } }) => ({ id: `TEST-PAYPAL-${amount.value}`, amount, approvalUrl: "https://example.test/approval" })) };
    const service = new PaymentService({ enabled: true, environment: "sandbox" } as never, provider as never);
    for (const [credit, expectedTax, expectedDue] of [["0.00", "8.75", "108.75"], ["40.00", "8.75", "68.75"]]) {
      const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", grossSubtotal: "100.00", taxableSubtotal: "100.00", tax: "0.00", total: "100.00", customerCreditApplied: credit, remainingTenderAmount: credit === "0.00" ? "100.00" : "60.00", selectedPaymentMethod: "paypal", taxSnapshot: { schemaVersion: 3, pendingTender: true }, checkoutConversionSnapshot: { pricingSnapshot: { subtotal: 100, tax: 0, total: 100 } }, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() }).returning();
      const first = await service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: `tax-e2e-paypal-${order.id}` });
      expect(first.replayed).toBe(false);
      const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id)).limit(1);
      expect(stored).toMatchObject({ tax: expectedTax, total: "108.75", remainingTenderAmount: expectedDue });
      expect(stored.taxSnapshot).toMatchObject({ schemaVersion: 3, taxRate: 0.0875, customerTaxCollected: Number(expectedTax), pendingTender: false });
      expect((stored.checkoutConversionSnapshot as { pricingSnapshot?: { tax?: number; total?: number } })?.pricingSnapshot).toMatchObject({ tax: Number(expectedTax), total: Number(stored.total) });
      const [attempt] = await db.select().from(paymentAttemptsTable).where(eq(paymentAttemptsTable.orderId, order.id)).limit(1);
      expect(attempt.requestedAmount).toBe(expectedDue);
      const replay = await service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: `tax-e2e-paypal-${order.id}` });
      expect(replay.replayed).toBe(true);
    }
    expect(provider.createOrder).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("captures PayPal once, rejects cross-tenant and stale finalization, and deduplicates verified webhooks", async () => {
    const provider = {
      createOrder: vi.fn(async ({ amount }: { amount: { value: string; currency: string } }) => ({ id: "TEST-PAYPAL-DB-CAPTURE", amount, approvalUrl: "https://example.test/approval" })),
      captureOrder: vi.fn(async () => ({ captureId: "TEST-PAYPAL-DB-CAPTURE-ID", orderId: "TEST-PAYPAL-DB-CAPTURE", status: "COMPLETED", amount: { value: "108.75", currency: "USD" }, fundingSource: "paypal" })),
      verifyWebhook: vi.fn(async () => true),
      getCapture: vi.fn(async () => ({ captureId: "TEST-PAYPAL-DB-CAPTURE-ID", orderId: "TEST-PAYPAL-DB-CAPTURE", status: "COMPLETED", amount: { value: "108.75", currency: "USD" } })),
    };
    const service = new PaymentService({ enabled: true, environment: "sandbox" } as never, provider as never);
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", grossSubtotal: "100.00", taxableSubtotal: "100.00", tax: "0.00", total: "100.00", remainingTenderAmount: "100.00", selectedPaymentMethod: "paypal", taxSnapshot: { schemaVersion: 3, pendingTender: true }, checkoutConversionSnapshot: { pricingSnapshot: { subtotal: 100, tax: 0, total: 100 } }, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() }).returning();
    const created = await service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: `capture-${order.id}` });
    const finalize = vi.fn(async () => undefined);
    await expect(service.capture({ tenantId: tenantId + 1, customerId, orderId: order.id, attemptId: created.attemptId!, idempotencyKey: "wrong-tenant", finalize })).rejects.toMatchObject({ statusCode: 404 });
    const first = await service.capture({ tenantId, customerId, orderId: order.id, attemptId: created.attemptId!, idempotencyKey: `capture-${order.id}`, finalize });
    expect(first).toMatchObject({ status: "captured", replayed: false });
    const replay = await service.capture({ tenantId, customerId, orderId: order.id, attemptId: created.attemptId!, idempotencyKey: `capture-${order.id}`, finalize });
    expect(replay).toMatchObject({ status: "captured", replayed: true });
    expect(provider.captureOrder).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(await db.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, created.attemptId!))).toHaveLength(1);
    const [paid] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
    expect(paid).toMatchObject({ paymentStatus: "paid", tax: "8.75", total: "108.75" });
    await expect(service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: "stale-create" })).rejects.toMatchObject({ code: "ORDER_ALREADY_PAID" });
    const event = { id: `TEST-PAYPAL-WEBHOOK-${order.id}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "TEST-PAYPAL-DB-CAPTURE-ID" } };
    const headers = { transmissionId: "test", transmissionTime: new Date().toISOString(), certificateUrl: "https://example.test/cert", authAlgorithm: "SHA256withRSA", transmissionSignature: "test" };
    provider.verifyWebhook.mockResolvedValueOnce(false);
    await expect(service.verifyAndRecordWebhook(headers, event)).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE" });
    expect(await db.select().from(paymentWebhookEventsTable).where(eq(paymentWebhookEventsTable.providerEventId, event.id))).toHaveLength(0);
    expect(await service.verifyAndRecordWebhook(headers, event)).toMatchObject({ replayed: false });
    expect(await service.verifyAndRecordWebhook(headers, event)).toMatchObject({ replayed: true });
    expect(await db.select().from(paymentWebhookEventsTable).where(eq(paymentWebhookEventsTable.providerEventId, event.id))).toHaveLength(1);
    expect((await db.select().from(ordersTable).where(eq(ordersTable.id, order.id)))[0].paymentStatus).toBe("paid");
  }, 60_000);

  it("settles an HTTP PayPal checkout against its immutable tax snapshot and decrements inventory once", async () => {
    const prior = Object.fromEntries(["PAYMENT_MODE", "PAYPAL_ENVIRONMENT", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"].map(key => [key, process.env[key]]));
    Object.assign(process.env, { PAYMENT_MODE: "sandbox", PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "synthetic-client-id", PAYPAL_CLIENT_SECRET: "synthetic-client-secret", PAYPAL_WEBHOOK_ID: "synthetic-webhook-id" });
    const createSpy = vi.spyOn(PayPalProvider.prototype, "createOrder").mockImplementation(async ({ amount }) => ({ id: "TEST-HTTP-PAYPAL-ORDER", status: "CREATED", amount, approvalUrl: "https://example.test/approve" }));
    const captureSpy = vi.spyOn(PayPalProvider.prototype, "captureOrder").mockImplementation(async () => ({ orderId: "TEST-HTTP-PAYPAL-ORDER", captureId: "TEST-HTTP-PAYPAL-CAPTURE", status: "COMPLETED", amount: { value: "108.75", currency: "USD" }, fundingSource: "paypal" }));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "paypal" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75 });
      const orderId = Number(created.body.id);
      const initialSnapshot = await db.execute(sql`SELECT tax_collected, tender FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
      expect(initialSnapshot.rows[0]).toMatchObject({ tax_collected: "8.75", tender: "paypal" });
      const payment = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `http-paypal-${orderId}`).send({});
      expect(payment.status, payment.text).toBe(201);
      const replayCreate = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `http-paypal-${orderId}`).send({});
      expect(replayCreate.status, replayCreate.text).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      const captured = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `http-capture-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(captured.status, captured.text).toBe(200);
      const replayCapture = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `http-capture-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(replayCapture.status, replayCapture.text).toBe(200);
      expect(captureSpy).toHaveBeenCalledTimes(1);
      const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND movement_type = 'sale'`);
      expect(sales.rows).toHaveLength(1);
      const finalSnapshot = await db.execute(sql`SELECT tax_collected, tender FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
      expect(finalSnapshot.rows).toEqual(initialSnapshot.rows);
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(order).toMatchObject({ paymentStatus: "paid", tax: "8.75", total: "108.75" });
    } finally {
      createSpy.mockRestore(); captureSpy.mockRestore();
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 60_000);

  it("settles cash-first then card, recovers after a declined card, and never marks partial payment paid", async () => {
    const prior = Object.fromEntries(["PAYMENT_MODE", "PAYPAL_ENVIRONMENT", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"].map(key => [key, process.env[key]]));
    Object.assign(process.env, { PAYMENT_MODE: "sandbox", PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "synthetic-client-id", PAYPAL_CLIENT_SECRET: "synthetic-client-secret", PAYPAL_WEBHOOK_ID: "synthetic-webhook-id" });
    const amounts = new Map<string, string>();
    let sequence = 0;
    const createSpy = vi.spyOn(PayPalProvider.prototype, "createOrder").mockImplementation(async ({ amount }) => {
      const id = `TEST-SPLIT-CASH-FIRST-${++sequence}`; amounts.set(id, amount.value);
      return { id, status: "CREATED", amount, approvalUrl: "https://example.test/approve" };
    });
    const captureSpy = vi.spyOn(PayPalProvider.prototype, "captureOrder")
      .mockRejectedValueOnce(new PayPalProviderError("declined", "sandbox decline"))
      .mockImplementation(async providerOrderId => ({ orderId: providerOrderId, captureId: `CAP-${providerOrderId}`, status: "COMPLETED", amount: { value: amounts.get(providerOrderId)!, currency: "USD" }, fundingSource: "card" }));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "split_tender" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      const orderId = Number(created.body.id);
      expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75, selectedPaymentMethod: "split_tender", remainingTenderAmount: 108.75 });
      const claimed = await as("csr").post(`/api/orders/${orderId}/accept`).send({});
      expect(claimed.status, claimed.text).toBe(200);
      const cash = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "40.00", idempotencyKey: `split-cash-first-${orderId}` });
      expect(cash.status, cash.text).toBe(200);
      expect(cash.body).toMatchObject({ paymentStatus: "unpaid", remainingTenderAmount: 68.75 });
      const [afterCash] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(afterCash).toMatchObject({ paymentStatus: "unpaid", remainingTenderAmount: "68.75", tax: "8.75", total: "108.75" });

      const priorStock = await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`);
      const stockBefore = Number(priorStock.rows[0]?.quantity_on_hand ?? 0);
      const payment = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `split-create-failed-${orderId}`).send({});
      expect(payment.status, payment.text).toBe(201);
      expect(amounts.get(payment.body.providerOrderId)).toBe("68.75");
      const declined = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `split-capture-failed-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(declined.status).toBe(502);
      const [afterDecline] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(afterDecline).toMatchObject({ paymentStatus: "unpaid", remainingTenderAmount: "68.75" });
      expect(Number((await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`)).rows[0]?.quantity_on_hand ?? 0)).toBe(stockBefore);

      const retry = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `split-create-retry-${orderId}`).send({});
      expect(retry.status, retry.text).toBe(201);
      const captured = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `split-capture-retry-${orderId}`).send({ attemptId: retry.body.attemptId });
      expect(captured.status, captured.text).toBe(200);
      expect(captured.body).toMatchObject({ status: "captured", remainingBalance: "0.00" });
      const replay = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `split-capture-retry-${orderId}`).send({ attemptId: retry.body.attemptId });
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.replayed).toBe(true);
      const [paid] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(paid).toMatchObject({ paymentStatus: "paid", paymentMethod: "cash+paypal_card", selectedPaymentMethod: "split_tender", remainingTenderAmount: "0.00" });
      expect(Number((await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`)).rows[0]?.quantity_on_hand ?? 0)).toBe(stockBefore - 1);
      const cashLedger = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.orderId, orderId)));
      expect(cashLedger).toHaveLength(1);
      expect(cashLedger[0]?.amount).toBe("40.00");
      expect(await db.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, retry.body.attemptId))).toHaveLength(1);
    } finally {
      createSpy.mockRestore(); captureSpy.mockRestore();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it("supports card-first partial settlement followed by exact cash balance", async () => {
    const prior = Object.fromEntries(["PAYMENT_MODE", "PAYPAL_ENVIRONMENT", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"].map(key => [key, process.env[key]]));
    Object.assign(process.env, { PAYMENT_MODE: "sandbox", PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "synthetic-client-id", PAYPAL_CLIENT_SECRET: "synthetic-client-secret", PAYPAL_WEBHOOK_ID: "synthetic-webhook-id" });
    const amounts = new Map<string, string>();
    const createSpy = vi.spyOn(PayPalProvider.prototype, "createOrder").mockImplementation(async ({ amount }) => {
      const id = `TEST-SPLIT-CARD-FIRST-${randomUUID()}`; amounts.set(id, amount.value);
      return { id, status: "CREATED", amount, approvalUrl: "https://example.test/approve" };
    });
    const captureSpy = vi.spyOn(PayPalProvider.prototype, "captureOrder").mockImplementation(async providerOrderId => ({ orderId: providerOrderId, captureId: `CAP-${providerOrderId}`, status: "COMPLETED", amount: { value: amounts.get(providerOrderId)!, currency: "USD" }, fundingSource: "card" }));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "split_tender" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      const orderId = Number(created.body.id);
      const claimed = await as("csr").post(`/api/orders/${orderId}/accept`).send({});
      expect(claimed.status, claimed.text).toBe(200);
      const priorStock = await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`);
      const stockBefore = Number(priorStock.rows[0]?.quantity_on_hand ?? 0);
      const payment = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `split-card-first-create-${orderId}`).send({ amount: "50.00" });
      expect(payment.status, payment.text).toBe(201);
      expect(amounts.get(payment.body.providerOrderId)).toBe("50.00");
      const card = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `split-card-first-capture-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(card.status, card.text).toBe(200);
      expect(card.body).toMatchObject({ status: "partially_captured", remainingBalance: "58.75" });
      const [partial] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(partial).toMatchObject({ paymentStatus: "unpaid", paymentMethod: "split_tender", remainingTenderAmount: "58.75" });
      expect(Number((await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`)).rows[0]?.quantity_on_hand ?? 0)).toBe(stockBefore);
      const replay = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `split-card-first-capture-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body).toMatchObject({ status: "partially_captured", replayed: true, remainingBalance: "58.75" });

      const cash = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "58.75", idempotencyKey: `split-card-first-cash-${orderId}` });
      expect(cash.status, cash.text).toBe(200);
      const [paid] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(paid).toMatchObject({ paymentStatus: "paid", paymentMethod: "cash+paypal_card", remainingTenderAmount: "0.00" });
      expect(await db.select().from(paymentCapturesTable).where(eq(paymentCapturesTable.paymentAttemptId, payment.body.attemptId))).toHaveLength(1);
      const cashLedger = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.orderId, orderId)));
      expect(cashLedger).toHaveLength(1);
      expect(cashLedger[0]?.amount).toBe("58.75");
      expect(Number((await db.execute(sql`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} ORDER BY location_id LIMIT 1`)).rows[0]?.quantity_on_hand ?? 0)).toBe(stockBefore - 1);
    } finally {
      createSpy.mockRestore(); captureSpy.mockRestore();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it("uses the server's configured tax rate for cash and preserves its snapshot", async () => {
    await db.update(taxConfigurationsTable).set({ rate: "0.08000000" }).where(eq(taxConfigurationsTable.tenantId, tenantId));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 100, tax: 8, total: 108 });
    const orderId = Number(created.body.id);
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "108.00", idempotencyKey: `tax-e2e-108-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ subtotal: 100, tax: 8, total: 108, cash: { amountDue: "108.00", amountTendered: "108.00", changeGiven: "0.00" } });
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    const [ledger] = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.orderId, orderId)));
    expect(stored).toMatchObject({ subtotal: "100.00", tax: "8.00", total: "108.00", remainingTenderAmount: "0.00", paymentStatus: "paid" });
    expect(ledger).toMatchObject({ amount: "108.00", amountTendered: "108.00", changeGiven: "0.00" });
  }, 60_000);

  it("shows tax-inclusive cash price but keeps taxable base and tax in the immutable snapshot", async () => {
    await db.update(adminSettingsTable).set({ cashTaxInclusive: true }).where(eq(adminSettingsTable.tenantId, tenantId));
    await db.update(taxConfigurationsTable).set({ rate: "0.08000000" }).where(eq(taxConfigurationsTable.tenantId, tenantId));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 92.59, tax: 7.41, total: 100 });
      const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id)));
      expect(stored.taxSnapshot).toMatchObject({ taxMode: "included", taxableSubtotal: 92.59, customerTaxableTenderBase: 92.59, customerTaxCollected: 7.41, tender: "cash", exemptionReason: null });
      const closeout = await as("csr").post(`/api/orders/${stored.id}/closeout`).send({ paymentMethod: "cash", amountTendered: "100.00", idempotencyKey: `included-cash-closeout-${stored.id}` });
      expect(closeout.status, closeout.text).toBe(200);
      const [includedLine] = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, stored.id));
      const returned = await as("admin").post(`/api/orders/${stored.id}/returns`).send({ lines: [{ orderItemId: includedLine.id, quantity: 1, disposition: "DO_NOT_RESTOCK" }], reason: "Inclusive cash tax return", idempotencyKey: `return:inclusive-cash-${stored.id}` });
      expect(returned.status, returned.text).toBe(200);
      expect(returned.body).toMatchObject({ refundAmount: "100.00", taxAmount: "7.41", tenderType: "cash" });
      await db.update(adminSettingsTable).set({ cashTaxInclusive: false }).where(eq(adminSettingsTable.tenantId, tenantId));
      const cardConfirmation = { ...confirmation, paymentMethod: "paypal" };
      const cardConverted = await as("customer").post("/api/cart/convert").send({ items, confirmation: cardConfirmation });
      const cardOrder = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: cardConverted.body.checkoutConversionToken, checkoutConversionSnapshot: cardConverted.body, checkoutConfirmation: cardConfirmation, deliveryMethod: "pickup" });
      expect(cardOrder.status, cardOrder.text).toBe(201);
      expect(cardOrder.body).toMatchObject({ subtotal: 100, tax: 8, total: 108 });
    } finally {
      await db.update(adminSettingsTable).set({ cashTaxInclusive: false }).where(eq(adminSettingsTable.tenantId, tenantId));
      await db.update(taxConfigurationsTable).set({ rate: "0.08750000" }).where(eq(taxConfigurationsTable.tenantId, tenantId));
    }
  }, 60_000);
  it("checks out the exact selected 4 oz variant and decrements only its separate inventory", async () => {
    const suffix = `VAR-${tenantId}-${Date.now()}`;
    const product = await as("admin").post("/api/admin/catalogue/products").send({
      name: `Variant Oil ${suffix}`, category: "Fixtures", price: "12.00", sku: `${suffix}-2OZ`,
      inventoryModel: "SEPARATE_VARIANTS", baseUnit: "each", consumptionQuantity: "1.000000", firstOptionLabel: "2 oz",
    });
    expect(product.status, product.text).toBe(201);
    await db.execute(sql`UPDATE catalogue_options SET label='2 oz', option_values='{"Size":"2 oz"}'::jsonb WHERE tenant_id=${tenantId} AND id=${product.body.optionId}`);
    const fourOz = await as("admin").post(`/api/admin/catalogue/products/${product.body.productId}/options`).send({
      label: "4 oz", optionValues: { Size: "4 oz" }, price: "19.50", sku: `${suffix}-4OZ`, consumptionQuantity: "1.000000",
    });
    expect(fourOz.status, fourOz.text).toBe(201);
    const options = await db.execute(sql`SELECT co.id AS "optionId",co.catalog_item_id AS "catalogItemId",co.inventory_item_id AS "inventoryItemId",
      ii.catalog_item_id AS "inventoryCatalogItemId",ci.sku FROM catalogue_options co
      JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
      JOIN catalog_items ci ON ci.tenant_id=co.tenant_id AND ci.id=co.catalog_item_id
      WHERE co.tenant_id=${tenantId} AND co.product_id=${product.body.productId} ORDER BY co.id`);
    expect(options.rows).toHaveLength(2);
    const two = options.rows[0] as { optionId: number; inventoryCatalogItemId: number };
    const four = options.rows[1] as { optionId: number; catalogItemId: number; inventoryItemId: number; inventoryCatalogItemId: number; sku: string };
    expect(four).toMatchObject({ optionId: fourOz.body.optionId, catalogItemId: fourOz.body.catalogItemId, sku: `${suffix}-4OZ` });
    expect(four.inventoryCatalogItemId).not.toBe(two.inventoryCatalogItemId);
    const [box] = await db.select().from(csrBoxesTable).where(eq(csrBoxesTable.tenantId, tenantId)).limit(1);
    const [location] = await db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.csrBoxId, box.id))).limit(1);
    await db.insert(inventoryBalancesTable).values([
      { tenantId, productId: two.inventoryCatalogItemId, locationId: location.id, quantityOnHand: "3", parLevel: "1" },
      { tenantId, productId: four.inventoryCatalogItemId, locationId: location.id, quantityOnHand: "7", parLevel: "1" },
    ]).onConflictDoUpdate({ target: [inventoryBalancesTable.tenantId, inventoryBalancesTable.productId, inventoryBalancesTable.locationId], set: { quantityOnHand: sql`excluded.quantity_on_hand`, parLevel: "1" } });
    const items = [{ optionId: four.optionId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items,
      checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body,
      checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [line] = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, created.body.id)).limit(1);
    expect(line).toMatchObject({ optionId: four.optionId, catalogItemId: four.catalogItemId, inventoryItemId: four.inventoryItemId,
      skuSnapshot: `${suffix}-4OZ`, unitPrice: "19.50", variantSnapshot: { variantId: four.optionId, sku: `${suffix}-4OZ`, optionValues: { Size: "4 oz" } } });
    const closeout = await as("csr").post(`/api/orders/${created.body.id}/closeout`).send({ paymentMethod: "cash",
      amountTendered: String(created.body.remainingTenderAmount), idempotencyKey: `variant-checkout-${created.body.id}` });
    expect(closeout.status, closeout.text).toBe(200);
    const after = await db.select().from(inventoryBalancesTable).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.locationId, location.id), inArray(inventoryBalancesTable.productId, [two.inventoryCatalogItemId, four.inventoryCatalogItemId])));
    expect(after.find(row => row.productId === two.inventoryCatalogItemId)?.quantityOnHand).toBe("3.000000");
    expect(after.find(row => row.productId === four.inventoryCatalogItemId)?.quantityOnHand).toBe("6.000000");
    const movement = await db.execute(sql`SELECT catalog_item_id,order_item_id,quantity_delta FROM inventory_movements WHERE tenant_id=${tenantId} AND order_id=${created.body.id} AND movement_type='sale'`);
    expect(movement.rows).toEqual([expect.objectContaining({ catalog_item_id: four.inventoryCatalogItemId, order_item_id: line.id, quantity_delta: "-1.000000000000" })]);
  }, 60_000);
});
