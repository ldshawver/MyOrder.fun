/** Runs only against an explicitly named disposable, migrated PostgreSQL clone. */
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { and, eq, sql } from "drizzle-orm";

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
import { adminSettingsTable, auditLogsTable, catalogItemsTable, cashLedgerEntriesTable, csrBoxesTable, customerCreditAccountsTable, customerCreditLedgerTable, customerDisclaimerAcceptancesTable, db, inventoryBalancesTable, inventoryLocationsTable, inventoryReservationsTable, inventoryValuationStatesTable, labTechShiftsTable, orderItemsTable, ordersTable, paymentAttemptsTable, paymentCapturesTable, paymentWebhookEventsTable, pool, taxConfigurationsTable, tenantSettingsTable, tenantsTable, uberDeliveryFulfillmentsTable, uberDeliveryQuotesTable, uberDirectSettingsTable, usersTable } from "@workspace/db";
import { PaymentService } from "../payments/service";
import { PayPalProvider } from "../payments/paypal";
import { encrypt } from "../lib/crypto";
import { normalizeUberAddress } from "../lib/uberDirect";
import { dispatchPendingUberDelivery, reconcileUberDelivery, requestUberCancellation } from "../lib/uberFulfillment";
import { adjustCustomerCredit } from "../payments/customerCredit";
import { saveTenantPayPalSettings } from "../payments/tenantConfig";
import { getCheckoutTaxSettings } from "../lib/checkoutNormalizer";

const integrationDescribe = process.env.RUN_TENDER_TAX_INTEGRATION === "1" ? describe : describe.skip;
integrationDescribe("Cash tender tax via conversion, order, and closeout routes", () => {
  let server: Server | undefined;
  let request: ReturnType<typeof supertest>;
  let catalogItemId: number;
  let tenantId: number;
  let customerId: number;
  let csrId: number;
  let otherAdminId: number;
  let otherTenantId: number;
  let locationTaxConfigurationId: number | undefined;
  type TestOrderBody = {
    items: Array<{ catalogItemId: number; quantity: number }>;
    paymentMethod?: string;
    deliveryMethod?: string;
    deliveryQuote?: { quoteId?: string };
    checkoutConfirmation?: { paymentMethod?: string; checkoutTaxQuoteToken?: string; customerCreditAmount?: number; tipAmount?: number };
  };
  const as = (who: keyof typeof people) => ({
    post: (path: string) => {
      const req = request.post(path).set("x-tax-e2e-user", who);
      if (path !== "/api/orders") return req;
      const send = req.send.bind(req);
      req.send = ((body: TestOrderBody) => {
        const confirmation = body.checkoutConfirmation;
        const tender = String(confirmation?.paymentMethod ?? body.paymentMethod ?? "cash");
        const processor = tender === "paypal_card" ? "paypal" : tender;
        if (!confirmation || confirmation.checkoutTaxQuoteToken || !["cash", "paypal", "customer_credit"].includes(processor)) return send(body);
        const quoteRequest = request.post("/api/checkout/quote").set("x-tax-e2e-user", who);
        return quoteRequest.send({
          items: body.items,
          paymentMethod: tender,
          customerCreditAmount: confirmation.customerCreditAmount,
          tipAmount: confirmation.tipAmount,
          deliveryMethod: body.deliveryMethod ?? "pickup",
          deliveryQuoteId: body.deliveryQuote?.quoteId,
        }).then(quote => {
          if (quote.status === 200) confirmation.checkoutTaxQuoteToken = quote.body.checkoutTaxQuoteToken;
          return send(body);
        });
      }) as typeof req.send;
      return req;
    },
  });

  const assertDisposableTarget = async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    let parsedUrl: URL;
    try { parsedUrl = new URL(databaseUrl); } catch { throw new Error("Explicit disposable tax clone required"); }
    if (parsedUrl.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)
      || parsedUrl.port !== "5432" || parsedUrl.search.length > 0 || decodeURIComponent(parsedUrl.pathname.slice(1)) !== "myorder_tax_production_like"
      || decodeURIComponent(parsedUrl.username) !== "codex_test"
      || process.env.TEST_DISPOSABLE_CLONE !== "I_UNDERSTAND_THIS_CLONE_IS_TRUNCATED"
      || ["TEST_DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].some(name => process.env[name])) {
      throw new Error("Explicit disposable tax clone required");
    }
    const target = await db.execute(sql`SELECT current_database() AS name, current_user AS role`);
    if (target.rows[0]?.name !== "myorder_tax_production_like" || target.rows[0]?.role !== "codex_test") {
      throw new Error("Disposable tax clone required");
    }
  };

  const resetAndSeedFixture = async () => {
    await assertDisposableTarget();
    // Clear application rows and identity sequences while retaining the
    // Drizzle lineage, the standalone P0 marker, extension-owned data, and all
    // schema objects. No CASCADE is used: an unexpected external FK fails
    // closed instead of expanding the deletion scope.
    await db.execute(sql`DO $reset$
      DECLARE table_list text;
      BEGIN
        SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
          INTO table_list
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname NOT IN ('__drizzle_migrations', 'myorder_hotfix_migrations')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          );
        IF table_list IS NULL THEN RAISE EXCEPTION 'No disposable application tables found'; END IF;
        EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
      END
    $reset$`);
    const preserved = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migration_rows,
      (SELECT count(*)::int FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance') AS p0_marker_rows`);
    if (Number(preserved.rows[0]?.migration_rows) !== 49 || Number(preserved.rows[0]?.p0_marker_rows) !== 1) {
      throw new Error("Disposable fixture reset did not preserve the verified migration lineage and P0 marker");
    }

    const [tenant] = await db.insert(tenantsTable).values({ name: "Tax E2E Tenant", slug: "tax-e2e-tenant", status: "active" }).returning();
    tenantId = tenant.id;
    await db.insert(adminSettingsTable).values({ tenantId: tenant.id, enabledProcessors: ["cash", "paypal"], orderRoutingRule: "round_robin", customerDisclaimerVersion: 1, customerDisclaimerText: "All sales are final. Confirm before checkout." });
    await saveTenantPayPalSettings(tenant.id, { enabled: true, environment: "sandbox", clientId: "synthetic-paypal-client", clientSecret: "synthetic-paypal-secret", webhookId: "synthetic-paypal-webhook" });
    const [otherTenant] = await db.insert(tenantsTable).values({ name: "Other Tax E2E Tenant", slug: "other-tax-e2e-tenant", status: "active" }).returning();
    otherTenantId = otherTenant.id;
    const seededUsers = await db.insert(usersTable).values([
      { clerkId: people.customer.clerkId, email: people.customer.email, normalizedEmail: people.customer.email, firstName: "Pat", lastName: "E2E", role: "user", tenantId: tenant.id, status: "approved", approvedByClerkId: "tax_e2e_approval_owner", approvedAt: new Date(), identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.csr.clerkId, email: people.csr.email, normalizedEmail: people.csr.email, firstName: "Casey", lastName: "E2E", role: "csr", tenantId: tenant.id, status: "approved", approvedByClerkId: "tax_e2e_approval_owner", approvedAt: new Date(), identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.admin.clerkId, email: people.admin.email, normalizedEmail: people.admin.email, firstName: "Ada", lastName: "E2E", role: "admin", tenantId: tenant.id, status: "approved", approvedByClerkId: "tax_e2e_approval_owner", approvedAt: new Date(), identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.otherAdmin.clerkId, email: people.otherAdmin.email, normalizedEmail: people.otherAdmin.email, firstName: "Sam", lastName: "E2E", role: "admin", tenantId: otherTenant.id, status: "approved", approvedByClerkId: "tax_e2e_approval_owner", approvedAt: new Date(), identityStatus: "verified", provisioningStatus: "active" },
    ]).returning();
    const [customer, csr, , otherAdmin] = seededUsers;
    customerId = customer.id;
    csrId = csr.id;
    otherAdminId = otherAdmin.id;
    await db.insert(taxConfigurationsTable).values({ tenantId, jurisdiction: "Test", rate: "0.08750000", sourcingRule: "tenant", effectiveFrom: "2020-01-01", sourceName: "Test fixture", sourceUrl: "https://example.test/tax", verifiedAt: new Date(), verifiedByUserId: csr.id });
    await db.insert(customerDisclaimerAcceptancesTable).values({ tenantId: tenant.id, userId: customer.id, disclaimerVersion: 1 });
    const [box] = await db.insert(csrBoxesTable).values({ tenantId: tenant.id, slug: "sales-box-1", label: "CSR Sales Box 1", displayOrder: 1 }).returning();
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId: tenant.id, type: "csr_box", csrBoxId: box.id, name: "CSR Sales Box 1", displayOrder: 1 }).returning();
    await db.insert(labTechShiftsTable).values({ tenantId: tenant.id, techId: csr.id, status: "active", boxAssignmentId: box.slug, cashBankStart: "100.00", setupJson: { boxAssignmentId: box.slug, inventoryConfirmed: true, parLevelsConfirmed: true, printerAssigned: true } });
    const [item] = await db.insert(catalogItemsTable).values({ tenantId: tenant.id, name: "Taxable $100 Fixture", description: "Neutral test product", category: "Fixtures", sku: "TAX-E2E-100", price: "100.00", isTaxable: true, stockQuantity: "10", inventoryAmount: "10", isAvailable: true, alavontName: "Taxable $100 Fixture", alavontDescription: "Neutral test product", alavontCategory: "Fixtures", alavontId: "TAX-E2E-100", alavontInStock: true, luciferCruzName: "Taxable $100 Fixture", luciferCruzDescription: "Neutral test product", luciferCruzCategory: "Fixtures", displayName: "Taxable $100 Fixture", displayDescription: "Neutral test product", displayCategory: "Fixtures", merchantBrandName: "Lucifer Cruz", customerSafeName: "Taxable $100 Fixture", customerSafeDescription: "Neutral test product", merchantName: "Taxable $100 Fixture", merchantDescription: "Neutral test product", merchantCategory: "Fixtures", merchantSku: "TAX-E2E-100", merchantBrand: "alavont", merchantProductSource: "local_mapped", merchantProcessingMode: "mapped_lucifer", receiptName: "Taxable $100 Fixture", labelName: "Taxable $100 Fixture", labName: "Taxable $100 Fixture" }).returning();
    catalogItemId = item.id;
    await db.insert(inventoryBalancesTable).values({ tenantId: tenant.id, productId: item.id, locationId: location.id, quantityOnHand: "10", parLevel: "2" });
    await db.insert(inventoryValuationStatesTable).values({ tenantId: tenant.id, inventoryEntityType: "catalog", catalogItemId: item.id, costStatus: "known", knownQuantity: "10", averageUnitCost: "20", inventoryValue: "200" });
  };

  beforeAll(async () => {
    await assertDisposableTarget();
    server = app.listen(0);
    request = supertest(server);
  }, 60_000);

  beforeEach(async () => {
    locationTaxConfigurationId = undefined;
    await resetAndSeedFixture();
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });

  afterEach(async () => {
    if (locationTaxConfigurationId != null) {
      await db.delete(taxConfigurationsTable).where(eq(taxConfigurationsTable.id, locationTaxConfigurationId));
      locationTaxConfigurationId = undefined;
    }
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
    const quoteId = "test-webhook-quote";
    const address = { street_address: ["500 Test Street"], city: "Testville", state: "CA", zip_code: "94105", country: "US" };
    await db.insert(uberDeliveryQuotesTable).values({ id: quoteId, tenantId, customerId, providerQuoteId: "dqt_synthetic_webhook", cartFingerprint: "synthetic-webhook", pickupAddress: address, dropoffAddress: address, manifestItems: [{ name: "Test Item", quantity: 1 }], feeCents: 500, currency: "USD", expiresAt: new Date(Date.now() + 600_000) });
    const [webhookOrder] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", tax: "0.00", total: "105.00", paymentStatus: "paid", deliveryMethod: "uber_direct", deliveryQuoteId: quoteId }).returning();
    await db.insert(uberDeliveryFulfillmentsTable).values({ tenantId, orderId: webhookOrder.id, quoteId, externalOrderReference: `myorder-${tenantId}-${webhookOrder.id}`, requestState: "delivery_create_pending" });
    const externalId = `myorder-${tenantId}-${webhookOrder.id}`;
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
    const [beforeDelivery] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, webhookOrder.id));
    expect(beforeDelivery.providerStatus).toBe("pickup");
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "canceling" }).where(eq(uberDeliveryFulfillmentsTable.orderId, webhookOrder.id));
    const duringCancel = await sendEvent("evt-uber-during-cancel", "pickup_complete");
    expect(duringCancel.status).toBe(200);
    const [inFlight] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, webhookOrder.id));
    expect(inFlight).toMatchObject({ providerStatus: "pickup_complete", requestState: "canceling" });
    const delivered = await sendEvent("evt-uber-delivered", "delivered");
    expect(delivered.status).toBe(200);
    const [afterDelivery] = await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.orderId, webhookOrder.id));
    expect(afterDelivery).toMatchObject({ providerDeliveryId: "del_synthetic_tenant_a", providerStatus: "delivered", requestState: "delivered" });
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, webhookOrder.id));
    expect(order.paymentStatus).toBe("paid");
  }, 60_000);

  it("quotes, accepts, pays, and dispatches Uber exactly once with a server-owned fee", async () => {
    const [storefront] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "storefront", name: "Synthetic Storefront", displayOrder: 3 }).returning();
    await db.insert(tenantSettingsTable).values({ tenantId, publicBusinessName: "Synthetic Shop", supportPhone: "+15555550111", businessAddressJson: { line1: "500 Test Street", city: "Testville", region: "CA", postalCode: "94105", country: "US" } }).onConflictDoUpdate({ target: tenantSettingsTable.tenantId, set: { publicBusinessName: "Synthetic Shop", supportPhone: "+15555550111", businessAddressJson: { line1: "500 Test Street", city: "Testville", region: "CA", postalCode: "94105", country: "US" } } });
    await db.update(usersTable).set({ contactPhone: "+15555550222" }).where(eq(usersTable.id, customerId));
    await db.insert(uberDirectSettingsTable).values({ tenantId, enabled: true, environment: "sandbox", customerId: "synthetic-uber-customer", clientId: "synthetic-uber-client", clientSecretCiphertext: encrypt("synthetic-uber-client-secret"), pickupLocationId: storefront.id, dispatchEnabled: true });
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
    const [pickupLocation] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    await db.insert(uberDirectSettingsTable).values({ tenantId, enabled: true, environment: "sandbox", customerId: "synthetic-uber-customer", clientId: "synthetic-uber-client", clientSecretCiphertext: encrypt("synthetic-uber-client-secret"), pickupLocationId: pickupLocation.id, dispatchEnabled: true });
    await db.insert(tenantSettingsTable).values({ tenantId, publicBusinessName: "Synthetic Shop", supportPhone: "+15555550111", businessAddressJson: { line1: "500 Test Street", city: "Testville", region: "CA", postalCode: "94105", country: "US" } });
    await db.update(usersTable).set({ contactPhone: "+15555550222" }).where(eq(usersTable.id, customerId));
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

  it("quotes, persists, and settles the same configured tax for a taxable $100 Cash order once", async () => {
    const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable)
      .where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    expect(location).toBeDefined();
    const [locationTax] = await db.insert(taxConfigurationsTable).values({
      tenantId,
      locationId: location.id,
      jurisdiction: "Location Test",
      rate: "0.08250000",
      sourcingRule: "pickup",
      effectiveFrom: "2020-01-01",
      sourceName: "Test fixture",
      sourceUrl: "https://example.test/location-tax",
      verifiedAt: new Date(),
      verifiedByUserId: csrId,
    }).returning();
    locationTaxConfigurationId = locationTax.id;
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
    expect(quote.status, quote.text).toBe(200);
    expect(quote.body).toMatchObject({ customerTax: 8.25, effectiveTaxRate: 0.0825, finalAmountDue: 108.25, tenderDue: 108.25 });
    const forgedQuote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash", tax: 0, total: 0 });
    expect(forgedQuote.status).toBe(400);
    const hostile = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup", tax: 0.01, total: 0.01 });
    expect(hostile.status).toBeGreaterThanOrEqual(400);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 100, tax: quote.body.customerTax, total: quote.body.finalAmountDue });
    const orderId = Number(created.body.id);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    expect(order).toMatchObject({ subtotal: "100.00", tax: "8.25", total: "108.25", remainingTenderAmount: "108.25" });
    expect(order.taxSnapshot).toMatchObject({ locationId: location.id, taxConfigurationId: locationTax.id, taxRate: 0.0825 });
    const initialSnapshot = await db.execute(sql`SELECT tax_collected, tender, tax_configuration_id, location_id, snapshot_json FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
    expect(initialSnapshot.rows).toHaveLength(1);
    expect(initialSnapshot.rows[0]).toMatchObject({ tax_collected: "8.25", tender: "cash", tax_configuration_id: locationTax.id, location_id: location.id });
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "110.00", idempotencyKey: `tax-e2e-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ subtotal: 100, tax: 8.25, total: 108.25 });
    const ledger = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.orderId, orderId), eq(cashLedgerEntriesTable.tenantId, order.tenantId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: "108.25", amountTendered: "110.00", changeGiven: "1.75" });
    const replay = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "110.00", idempotencyKey: `tax-e2e-${orderId}` });
    expect(replay.status, replay.text).toBe(200);
    expect(await db.select().from(cashLedgerEntriesTable).where(eq(cashLedgerEntriesTable.orderId, orderId))).toHaveLength(1);
    const finalSnapshot = await db.execute(sql`SELECT tax_collected, tender, tax_configuration_id, location_id, snapshot_json FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
    expect(finalSnapshot.rows).toEqual(initialSnapshot.rows);
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND movement_type = 'sale'`);
    expect(sales.rows).toHaveLength(1);
  }, 60_000);

  it("rejects both a cash quote and order when no effective tax configuration exists", async () => {
    const [taxConfig] = await db.select().from(taxConfigurationsTable).where(eq(taxConfigurationsTable.tenantId, tenantId));
    expect(taxConfig).toBeDefined();
    await db.delete(taxConfigurationsTable).where(eq(taxConfigurationsTable.id, taxConfig.id));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
      expect(quote.status).toBe(422);
      expect(quote.body.error).toBe("CHECKOUT_QUOTE_UNAVAILABLE");
      const before = await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.tenantId, tenantId));
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status).toBe(422);
      expect(created.body.error).toBe("TAX_CONFIGURATION_UNAVAILABLE");
      const after = await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.tenantId, tenantId));
      expect(after).toEqual(before);
    } finally {
      await db.insert(taxConfigurationsTable).values({
        tenantId: taxConfig.tenantId,
        locationId: taxConfig.locationId,
        jurisdiction: taxConfig.jurisdiction,
        rate: taxConfig.rate,
        sourcingRule: taxConfig.sourcingRule,
        effectiveFrom: taxConfig.effectiveFrom,
        effectiveUntil: taxConfig.effectiveUntil,
        sourceName: taxConfig.sourceName,
        sourceUrl: taxConfig.sourceUrl,
        verifiedAt: taxConfig.verifiedAt,
        verifiedByUserId: taxConfig.verifiedByUserId,
      });
    }
  }, 60_000);

  it("keeps quote tax configuration tenant-scoped and rejects client-selected locations", async () => {
    await db.insert(taxConfigurationsTable).values({ tenantId: otherTenantId, jurisdiction: "Other Tenant Test", rate: "0.25000000", sourcingRule: "tenant", effectiveFrom: "2020-01-01", sourceName: "Test fixture", sourceUrl: "https://example.test/other-tax", verifiedAt: new Date(), verifiedByUserId: otherAdminId });
    const items = [{ catalogItemId, quantity: 1 }];
    const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
    expect(quote.status, quote.text).toBe(200);
    expect(quote.body).toMatchObject({ effectiveTaxRate: 0.0875, customerTax: 8.75 });
    expect(quote.body.checkoutTaxQuoteToken).toEqual(expect.any(String));
    const attemptedLocationOverride = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash", locationId: 999999 });
    expect(attemptedLocationOverride.status).toBe(400);
  });

  it("rejects a stale checkout quote after the server-selected fulfillment location changes", async () => {
    const [shift] = await db.select({ id: labTechShiftsTable.id }).from(labTechShiftsTable)
      .where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active"))).limit(1);
    const [box2] = await db.insert(csrBoxesTable).values({ tenantId, slug: "sales-box-2", label: "CSR Sales Box 2", displayOrder: 2 }).returning();
    const [location2] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "csr_box", csrBoxId: box2.id, name: "CSR Sales Box 2", displayOrder: 2 }).returning();
    const [locationTax] = await db.insert(taxConfigurationsTable).values({ tenantId, locationId: location2.id, jurisdiction: "Location Two Test", rate: "0.07000000", sourcingRule: "pickup", effectiveFrom: "2020-01-01", sourceName: "Test fixture", sourceUrl: "https://example.test/location-two-tax", verifiedAt: new Date(), verifiedByUserId: csrId }).returning();
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "Test confirmation", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
    expect(quote.status, quote.text).toBe(200);
    expect(quote.body.effectiveTaxRate).toBe(0.0875);
    const before = await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.tenantId, tenantId));
    try {
      await db.update(labTechShiftsTable).set({ boxAssignmentId: box2.slug }).where(and(eq(labTechShiftsTable.id, shift.id), eq(labTechShiftsTable.tenantId, tenantId)));
      const changedLocationQuote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
      expect(changedLocationQuote.status, changedLocationQuote.text).toBe(200);
      expect(changedLocationQuote.body.effectiveTaxRate).toBe(0.07);
      const staleCreate = await as("customer").post("/api/orders").send({
        orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken,
        checkoutConversionSnapshot: converted.body,
        checkoutConfirmation: { ...confirmation, checkoutTaxQuoteToken: quote.body.checkoutTaxQuoteToken },
        deliveryMethod: "pickup",
      });
      expect(staleCreate.status).toBe(409);
      expect(staleCreate.body.error).toBe("CHECKOUT_QUOTE_STALE");
      expect(await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.tenantId, tenantId))).toEqual(before);
    } finally {
      await db.update(labTechShiftsTable).set({ boxAssignmentId: "sales-box-1" }).where(and(eq(labTechShiftsTable.id, shift.id), eq(labTechShiftsTable.tenantId, tenantId)));
      await db.delete(taxConfigurationsTable).where(eq(taxConfigurationsTable.id, locationTax.id));
      await db.delete(inventoryLocationsTable).where(eq(inventoryLocationsTable.id, location2.id));
      await db.delete(csrBoxesTable).where(eq(csrBoxesTable.id, box2.id));
    }
  }, 60_000);

  it("serializes competing cash checkouts when only one can reserve the remaining inventory", async () => {
    const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    const [startingBalance] = await db.select({ quantityOnHand: inventoryBalancesTable.quantityOnHand }).from(inventoryBalancesTable).where(and(
      eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, catalogItemId), eq(inventoryBalancesTable.locationId, location.id),
    ));
    expect(Number(startingBalance.quantityOnHand)).toBe(10);
    expect(await db.select().from(inventoryReservationsTable).where(eq(inventoryReservationsTable.status, "reserved"))).toHaveLength(0);
    const items = [{ catalogItemId, quantity: 6 }];
    const confirmation = () => ({ acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "Test confirmation", paymentMethod: "cash" });
    const [convertedA, convertedB] = await Promise.all([
      as("customer").post("/api/cart/convert").send({ items, confirmation: confirmation() }),
      as("customer").post("/api/cart/convert").send({ items, confirmation: confirmation() }),
    ]);
    expect(convertedA.status).toBe(200);
    expect(convertedB.status).toBe(200);
    const before = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}) AS orders,
      (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.tenant_id = ${tenantId}) AS order_items,
      (SELECT count(*)::int FROM order_tax_snapshots WHERE tenant_id = ${tenantId}) AS snapshots,
      (SELECT count(*)::int FROM payment_attempts WHERE tenant_id = ${tenantId}) AS attempts,
      (SELECT count(*)::int FROM payment_captures c JOIN payment_attempts p ON p.id = c.payment_attempt_id WHERE p.tenant_id = ${tenantId}) AS captures,
      (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'reserved') AS reserved,
      (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'released') AS released,
      (SELECT quantity_on_hand::text FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${catalogItemId} AND location_id = ${location.id}) AS stock,
      (SELECT count(*)::int FROM inventory_movements WHERE tenant_id = ${tenantId}) AS movements`);
    const submit = (converted: typeof convertedA) => as("customer").post("/api/orders").send({
      orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken,
      checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation(), deliveryMethod: "pickup",
    });
    const results = await Promise.all([submit(convertedA), submit(convertedB)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const after = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}) AS orders,
      (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.tenant_id = ${tenantId}) AS order_items,
      (SELECT count(*)::int FROM order_tax_snapshots WHERE tenant_id = ${tenantId}) AS snapshots,
      (SELECT count(*)::int FROM payment_attempts WHERE tenant_id = ${tenantId}) AS attempts,
      (SELECT count(*)::int FROM payment_captures c JOIN payment_attempts p ON p.id = c.payment_attempt_id WHERE p.tenant_id = ${tenantId}) AS captures,
      (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'reserved') AS reserved,
      (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'released') AS released,
      (SELECT quantity_on_hand::text FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${catalogItemId} AND location_id = ${location.id}) AS stock,
      (SELECT count(*)::int FROM inventory_movements WHERE tenant_id = ${tenantId}) AS movements`);
    expect(Number(after.rows[0].orders) - Number(before.rows[0].orders)).toBe(1);
    expect(Number(after.rows[0].order_items) - Number(before.rows[0].order_items)).toBe(1);
    expect(Number(after.rows[0].snapshots) - Number(before.rows[0].snapshots)).toBe(1);
    expect(Number(after.rows[0].attempts) - Number(before.rows[0].attempts)).toBe(0);
    expect(Number(after.rows[0].captures) - Number(before.rows[0].captures)).toBe(0);
    expect(Number(after.rows[0].reserved) - Number(before.rows[0].reserved)).toBe(1);
    expect(Number(after.rows[0].released) - Number(before.rows[0].released)).toBe(0);
    expect(Number(after.rows[0].stock)).toBe(Number(before.rows[0].stock));
    expect(Number(after.rows[0].movements) - Number(before.rows[0].movements)).toBe(0);
    const reservedBeforeCloseout = await db.execute(sql`SELECT
      count(*)::int AS reservation_rows,
      COALESCE(SUM(r.quantity), 0)::numeric AS reserved,
      (SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} AND location_id=${location.id})::numeric AS qoh,
      (SELECT count(*)::int FROM cash_ledger_entries WHERE tenant_id=${tenantId}) AS cash_ledger
      FROM inventory_reservations r JOIN orders o ON o.id=r.order_id
      WHERE o.tenant_id=${tenantId} AND r.catalog_item_id=${catalogItemId} AND r.location_id=${location.id} AND r.status='reserved'`);
    expect(Number(reservedBeforeCloseout.rows[0]?.reserved)).toBe(6);
    expect(Number(reservedBeforeCloseout.rows[0]?.reservation_rows)).toBe(1);
    expect(Number(reservedBeforeCloseout.rows[0]?.qoh)).toBe(10);
    expect(Number(reservedBeforeCloseout.rows[0]?.qoh) - Number(reservedBeforeCloseout.rows[0]?.reserved)).toBe(4);
    expect(Number(reservedBeforeCloseout.rows[0]?.cash_ledger)).toBe(0);

    const winner = results.find(result => result.status === 201)!;
    const closeout = await as("csr").post(`/api/orders/${winner.body.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: Number(winner.body.total).toFixed(2), idempotencyKey: `tax-e2e-competing-${winner.body.id}`,
    });
    expect(closeout.status, closeout.text).toBe(200);
    const final = await db.execute(sql`SELECT
      (SELECT quantity_on_hand::numeric FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId} AND location_id=${location.id}) AS qoh,
      (SELECT COALESCE(SUM(quantity),0)::numeric FROM inventory_reservations WHERE order_id=${Number(winner.body.id)} AND status='confirmed') AS confirmed,
      (SELECT count(*)::int FROM inventory_movements WHERE tenant_id=${tenantId} AND order_id=${Number(winner.body.id)} AND movement_type='sale') AS sales,
      (SELECT count(*)::int FROM cash_ledger_entries WHERE tenant_id=${tenantId} AND order_id=${Number(winner.body.id)}) AS ledger,
      (SELECT status FROM orders WHERE tenant_id=${tenantId} AND id=${Number(winner.body.id)}) AS status,
      (SELECT payment_status FROM orders WHERE tenant_id=${tenantId} AND id=${Number(winner.body.id)}) AS payment_status`);
    expect(Number(final.rows[0]?.qoh)).toBe(4);
    expect(Number(final.rows[0]?.confirmed)).toBe(6);
    expect(Number(final.rows[0]?.sales)).toBe(1);
    expect(Number(final.rows[0]?.ledger)).toBe(1);
    expect(final.rows[0]).toMatchObject({ status: "completed", payment_status: "paid" });
  }, 60_000);

  it("rolls back order, snapshot, payment, and inventory writes when reservation cannot be completed", async () => {
    const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    await db.update(inventoryBalancesTable).set({ quantityOnHand: "1" }).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, catalogItemId), eq(inventoryBalancesTable.locationId, location.id)));
    try {
      expect(await db.select().from(inventoryReservationsTable).where(eq(inventoryReservationsTable.status, "reserved"))).toHaveLength(0);
      const [startingBalance] = await db.select({ quantityOnHand: inventoryBalancesTable.quantityOnHand }).from(inventoryBalancesTable).where(and(
        eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, catalogItemId), eq(inventoryBalancesTable.locationId, location.id),
      ));
      expect(Number(startingBalance.quantityOnHand)).toBe(1);
      const items = [{ catalogItemId, quantity: 2 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "Test confirmation", paymentMethod: "cash" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status).toBe(200);
      const before = await db.execute(sql`SELECT
        (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}) AS orders,
        (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.tenant_id = ${tenantId}) AS order_items,
        (SELECT count(*)::int FROM order_tax_snapshots WHERE tenant_id = ${tenantId}) AS snapshots,
        (SELECT count(*)::int FROM payment_attempts WHERE tenant_id = ${tenantId}) AS attempts,
        (SELECT count(*)::int FROM payment_captures c JOIN payment_attempts p ON p.id = c.payment_attempt_id WHERE p.tenant_id = ${tenantId}) AS captures,
        (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'reserved') AS reserved,
        (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'released') AS released,
        (SELECT quantity_on_hand::text FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${catalogItemId} AND location_id = ${location.id}) AS stock,
        (SELECT count(*)::int FROM inventory_movements WHERE tenant_id = ${tenantId}) AS movements`);
      expect(before.rows[0]).toMatchObject({ orders: 0, order_items: 0, snapshots: 0, attempts: 0, captures: 0, reserved: 0, released: 0, movements: 0 });
      expect(Number(before.rows[0]?.stock)).toBe(1);
      const failed = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(failed.status).toBe(409);
      expect(failed.body.legacyError).toBe("Insufficient inventory");
      const after = await db.execute(sql`SELECT
        (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}) AS orders,
        (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.tenant_id = ${tenantId}) AS order_items,
        (SELECT count(*)::int FROM order_tax_snapshots WHERE tenant_id = ${tenantId}) AS snapshots,
        (SELECT count(*)::int FROM payment_attempts WHERE tenant_id = ${tenantId}) AS attempts,
        (SELECT count(*)::int FROM payment_captures c JOIN payment_attempts p ON p.id = c.payment_attempt_id WHERE p.tenant_id = ${tenantId}) AS captures,
        (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'reserved') AS reserved,
        (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.tenant_id = ${tenantId} AND r.status = 'released') AS released,
        (SELECT quantity_on_hand::text FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${catalogItemId} AND location_id = ${location.id}) AS stock,
        (SELECT count(*)::int FROM inventory_movements WHERE tenant_id = ${tenantId}) AS movements`);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await db.update(inventoryBalancesTable).set({ quantityOnHand: "10" }).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, catalogItemId), eq(inventoryBalancesTable.locationId, location.id)));
    }
  }, 60_000);

  it("pays a taxable $100 cart entirely with Customer Credit including the tax-inclusive total", async () => {
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 10875, reason: "Disposable tax test fixture", idempotencyKey: "tax-e2e-credit-funding" }));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "customer_credit", customerCreditAmount: 108.75 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id))).limit(1);
    expect(stored).toMatchObject({ subtotal: "100.00", tax: "8.75", total: "108.75", customerCreditApplied: "108.75", remainingTenderAmount: "0.00", paymentStatus: "paid" });
    expect(stored.taxSnapshot).toMatchObject({ taxRate: 0.0875, taxableMerchandiseBase: 100, customerTaxCollected: 8.75, tenderAllocation: { customerCreditCents: 10875, externalTenderCents: 0 } });
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${stored.id} AND movement_type = 'sale'`);
    expect(sales.rows).toHaveLength(1);
    const [orderItem] = await db.select({ id: orderItemsTable.id }).from(orderItemsTable).where(eq(orderItemsTable.orderId, stored.id)).limit(1);
    const returnBody = { lines: [{ orderItemId: orderItem.id, quantity: 1, disposition: "RESTOCK" }], reason: "Synthetic full credit return", idempotencyKey: `return:tax-credit-${stored.id}` };
    const returns = await Promise.all([
      as("admin").post(`/api/orders/${stored.id}/returns`).send(returnBody),
      as("admin").post(`/api/orders/${stored.id}/returns`).send(returnBody),
    ]);
    expect(returns.map(result => result.status).sort()).toEqual([200, 200]);
    expect(returns.map(result => result.body.idempotent).sort()).toEqual([false, true]);
    const returned = returns.find(result => !result.body.idempotent)!;
    expect(returned.body).toMatchObject({ refundAmount: "108.75", taxAmount: "8.75", tenderType: "customer_credit" });
    const [restoredAccount] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
    expect(restoredAccount).toMatchObject({ balance: "108.75", reservedBalance: "0.00" });
    const refundSnapshot = await db.execute(sql`SELECT tax_collected, tax_refunded, snapshot_json FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${stored.id}`);
    expect(refundSnapshot.rows[0]).toMatchObject({ tax_collected: "8.75", tax_refunded: "0.00" });
    const refundLedger = await db.execute(sql`SELECT COALESCE(sum(tax_amount),0)::numeric::text AS tax_refunded FROM return_transactions WHERE tenant_id=${tenantId} AND order_id=${stored.id} AND status='completed'`);
    expect(refundLedger.rows[0]?.tax_refunded).toBe("8.75");
    expect((refundSnapshot.rows[0] as { snapshot_json: { tax?: Record<string, unknown> } }).snapshot_json.tax).toMatchObject({ taxCollected: 8.75, taxableMerchandiseBase: 100 });
    const replayedReturn = await as("admin").post(`/api/orders/${stored.id}/returns`).send(returnBody);
    expect(replayedReturn.status, replayedReturn.text).toBe(200);
    expect(replayedReturn.body.idempotent).toBe(true);
    const [afterReplayAccount] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
    expect(afterReplayAccount.balance).toBe("108.75");
  }, 60_000);

  it("allocates sequential partial cash and Customer Credit refunds proportionally in exact cents", async () => {
    await db.update(catalogItemsTable).set({ price: "50.00" }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, catalogItemId)));
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 4000, reason: "Disposable proportional refund fixture", idempotencyKey: "tax-e2e-proportional-credit" }));
    const items = [{ catalogItemId, quantity: 2 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash", customerCreditAmount: 40 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 100, tax: 8.75, total: 108.75, customerCreditApplied: 40, remainingTenderAmount: 68.75 });
    const orderId = Number(created.body.id);
    const [orderItem] = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId)).limit(1);
    expect(orderItem.quantity).toBe(2);
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "68.75", idempotencyKey: `tax-e2e-proportional-cash-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    const before = await db.execute(sql`SELECT tax_collected, tax_refunded, snapshot_json FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
    const refund = (key: string) => as("admin").post(`/api/orders/${orderId}/returns`).send({ lines: [{ orderItemId: orderItem.id, quantity: 1, disposition: "DO_NOT_RESTOCK" }], reason: "Proportional partial refund", idempotencyKey: key });
    const first = await refund(`return:proportional-first-${orderId}`);
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ refundAmount: "54.38", taxAmount: "4.38", creditRefundAmount: "20.00", cashRefundAmount: "34.38" });
    const duplicate = await refund(`return:proportional-first-${orderId}`);
    expect(duplicate.status, duplicate.text).toBe(200);
    expect(duplicate.body.idempotent).toBe(true);
    const competing = await Promise.all([
      refund(`return:proportional-second-a-${orderId}`),
      refund(`return:proportional-second-b-${orderId}`),
    ]);
    expect(competing.map(result => result.status).sort()).toEqual([200, 409]);
    expect(competing.find(result => result.status === 200)?.body).toMatchObject({ refundAmount: "54.37", taxAmount: "4.37", creditRefundAmount: "20.00", cashRefundAmount: "34.37" });
    const [account] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
    expect(account.balance).toBe("40.00");
    const reconciled = await db.execute(sql`SELECT
      (SELECT COALESCE(sum(abs(amount)),0)::numeric::text FROM cash_ledger_entries WHERE tenant_id=${tenantId} AND order_id=${orderId} AND entry_type='cash_refund') AS cash_refunded,
      (SELECT COALESCE(sum(amount),0)::numeric::text FROM customer_credit_ledger WHERE tenant_id=${tenantId} AND order_id=${orderId} AND entry_type='refund_restoration') AS credit_refunded,
      (SELECT COALESCE(sum(tax_amount),0)::numeric::text FROM return_transactions WHERE tenant_id=${tenantId} AND order_id=${orderId} AND status='completed') AS tax_refunded,
      (SELECT COALESCE(sum(refund_amount),0)::numeric::text FROM return_transactions WHERE tenant_id=${tenantId} AND order_id=${orderId} AND status='completed') AS gross_refunded`);
    expect(reconciled.rows[0]).toMatchObject({ cash_refunded: "68.75", credit_refunded: "40.00", tax_refunded: "8.75", gross_refunded: "108.75" });
    const after = await db.execute(sql`SELECT tax_collected, tax_refunded, snapshot_json FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
    expect(after.rows).toEqual(before.rows);
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
    expect(stored.taxSnapshot).toMatchObject({ taxableMerchandiseBase: 100, customerTaxCollected: 8.75, tenderAllocation: { customerCreditCents: 4000, externalTenderCents: 6875 } });
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

  it("proportionally refunds a PayPal and Customer Credit return once and preserves its tax snapshot", async () => {
    await db.update(catalogItemsTable).set({ price: "50.00" }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, catalogItemId)));
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 4000, reason: "Disposable PayPal refund fixture", idempotencyKey: "tax-e2e-paypal-refund-credit" }));
    let capturedAmount = { value: "0.00", currency: "USD" };
    const createSpy = vi.spyOn(PayPalProvider.prototype, "createOrder").mockImplementation(async ({ amount }) => {
      capturedAmount = amount;
      return { id: "TEST-PROPORTIONAL-REFUND-ORDER", status: "CREATED", amount, approvalUrl: "https://example.test/approval" };
    });
    const captureSpy = vi.spyOn(PayPalProvider.prototype, "captureOrder").mockImplementation(async () => ({
      orderId: "TEST-PROPORTIONAL-REFUND-ORDER", captureId: "TEST-PROPORTIONAL-REFUND-CAPTURE", status: "COMPLETED", amount: capturedAmount, fundingSource: "paypal",
    }));
    const refundSpy = vi.spyOn(PayPalProvider.prototype, "refundCapture").mockImplementation(async (_captureId, amount) => ({
      refundId: "TEST-PROPORTIONAL-REFUND-ID", status: "COMPLETED", amount,
    }));
    try {
      const items = [{ catalogItemId, quantity: 2 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "paypal", customerCreditAmount: 40 };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ total: 108.75, customerCreditApplied: 40, remainingTenderAmount: 68.75 });
      const orderId = Number(created.body.id);
      const payment = await as("customer").post(`/api/payments/paypal/orders/${orderId}`).set("Idempotency-Key", `paypal-refund-source-${orderId}`).send({});
      expect(payment.status, payment.text).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: { value: "68.75", currency: "USD" } }));
      const capture = await as("customer").post(`/api/payments/paypal/orders/${orderId}/capture`).set("Idempotency-Key", `paypal-refund-capture-${orderId}`).send({ attemptId: payment.body.attemptId });
      expect(capture.status, capture.text).toBe(200);
      const [orderItem] = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId)).limit(1);
      const originalSnapshot = await db.execute(sql`SELECT tax_collected, tax_refunded, snapshot_json FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
      const refundBody = { lines: [{ orderItemId: orderItem.id, quantity: 1, disposition: "DO_NOT_RESTOCK" }], reason: "PayPal split tender partial return", idempotencyKey: `return:paypal-proportional-${orderId}` };
      const refunded = await as("admin").post(`/api/orders/${orderId}/returns`).send(refundBody);
      expect(refunded.status, refunded.text).toBe(200);
      expect(refunded.body).toMatchObject({ refundAmount: "54.38", taxAmount: "4.38", creditRefundAmount: "20.00", paypalRefundAmount: "34.38" });
      expect(refundSpy).toHaveBeenCalledTimes(1);
      expect(refundSpy.mock.calls[0]?.[1]).toEqual({ value: "34.38", currency: "USD" });
      const replay = await as("admin").post(`/api/orders/${orderId}/returns`).send(refundBody);
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.idempotent).toBe(true);
      expect(refundSpy).toHaveBeenCalledTimes(1);
      const afterSnapshot = await db.execute(sql`SELECT tax_collected, tax_refunded, snapshot_json FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
      expect(afterSnapshot.rows).toEqual(originalSnapshot.rows);
      const [account] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
      expect(account.balance).toBe("20.00");
      const refundTotals = await db.execute(sql`SELECT
        (SELECT COALESCE(sum(ccl.amount),0)::numeric::text FROM customer_credit_ledger ccl WHERE ccl.tenant_id=${tenantId} AND ccl.order_id=${orderId} AND ccl.entry_type='refund_restoration') AS credit_refunded,
        (SELECT COALESCE(sum(pr.amount),0)::numeric::text FROM payment_refunds pr JOIN payment_captures pc ON pc.id=pr.payment_capture_id JOIN payment_attempts pa ON pa.id=pc.payment_attempt_id WHERE pa.tenant_id=${tenantId} AND pa.order_id=${orderId} AND pr.state='locally_finalized') AS paypal_refunded,
        (SELECT COALESCE(sum(tax_amount),0)::numeric::text FROM return_transactions WHERE tenant_id=${tenantId} AND order_id=${orderId} AND status='completed') AS tax_refunded`);
      expect(refundTotals.rows[0]).toMatchObject({ credit_refunded: "20.00", paypal_refunded: "34.38", tax_refunded: "4.38" });
    } finally {
      createSpy.mockRestore(); captureSpy.mockRestore(); refundSpy.mockRestore();
    }
  }, 60_000);

  it("applies split Customer Credit after tax for mixed taxable and nontaxable merchandise", async () => {
    const [template] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, catalogItemId)).limit(1);
    const { id: templateId, ...templateValues } = template;
    expect(templateId).toBe(catalogItemId);
    const [nontaxable] = await db.insert(catalogItemsTable).values({
      ...templateValues,
      name: "Nontaxable $20 Fixture",
      sku: "TAX-E2E-NONTAX-20",
      price: "20.00",
      isTaxable: false,
      stockQuantity: "10",
      inventoryAmount: "10",
      alavontName: "Nontaxable $20 Fixture",
      alavontDescription: "Synthetic nontaxable item",
      alavontId: "TAX-E2E-NONTAX-20",
      luciferCruzName: "Nontaxable $20 Fixture",
      customerSafeName: "Nontaxable $20 Fixture",
      merchantName: "Nontaxable $20 Fixture",
      receiptName: "Nontaxable $20 Fixture",
      labelName: "Nontaxable $20 Fixture",
      labName: "Nontaxable $20 Fixture",
    }).returning();
    const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    await db.insert(inventoryBalancesTable).values({ tenantId, productId: nontaxable.id, locationId: location.id, quantityOnHand: "10", parLevel: "2" });
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 4000, reason: "Disposable mixed-cart credit", idempotencyKey: "tax-e2e-mixed-credit" }));
    const items = [{ catalogItemId, quantity: 1 }, { catalogItemId: nontaxable.id, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "paypal", customerCreditAmount: 40 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id))).limit(1);
    expect(stored).toMatchObject({ subtotal: "120.00", taxableSubtotal: "100.00", nonTaxableSubtotal: "20.00", tax: "8.75", total: "128.75", customerCreditApplied: "40.00", remainingTenderAmount: "88.75" });
    expect(stored.taxSnapshot).toMatchObject({ taxableMerchandiseBase: 100, customerTaxCollected: 8.75, tenderAllocation: { customerCreditCents: 4000, externalTenderCents: 8875 } });
  }, 60_000);

  it("serializes concurrent Customer Credit reservations and rolls back the losing order", async () => {
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 4000, reason: "Disposable concurrent credit", idempotencyKey: "tax-e2e-concurrent-credit" }));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = () => ({ acceptedAllSalesFinal: true as const, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash", customerCreditAmount: 40 });
    const convert = async () => {
      const result = await as("customer").post("/api/cart/convert").send({ items, confirmation: confirmation() });
      expect(result.status, result.text).toBe(200);
      return result.body;
    };
    const [firstConversion, secondConversion] = await Promise.all([convert(), convert()]);
    const beforeOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id=${tenantId}`);
    const submit = (conversion: typeof firstConversion) => as("customer").post("/api/orders").send({
      orderType: "WALK_IN", items, checkoutConversionToken: conversion.checkoutConversionToken,
      checkoutConversionSnapshot: conversion, checkoutConfirmation: confirmation(), deliveryMethod: "pickup",
    });
    const results = await Promise.all([submit(firstConversion), submit(secondConversion)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const afterOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id=${tenantId}`);
    expect(afterOrders.rows[0]?.n).toBe(Number(beforeOrders.rows[0]?.n) + 1);
    const [account] = await db.select().from(customerCreditAccountsTable).where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId)));
    expect(account).toMatchObject({ balance: "40.00", reservedBalance: "40.00" });
    const reservations = await db.select().from(customerCreditLedgerTable).where(and(eq(customerCreditLedgerTable.tenantId, tenantId), eq(customerCreditLedgerTable.entryType, "order_reservation")));
    expect(reservations).toHaveLength(1);
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
    const confirmation: { acceptedAllSalesFinal: boolean; confirmedAt: string; legalDisclaimerText: string; paymentMethod: string; checkoutTaxQuoteToken?: string } = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash", deliveryMethod: "pickup" });
    expect(quote.status, quote.text).toBe(200);
    confirmation.checkoutTaxQuoteToken = quote.body.checkoutTaxQuoteToken;
    const body = { orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" };
    const [first, second] = await Promise.all([as("customer").post("/api/orders").send(body), as("customer").post("/api/orders").send(body)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.id).toBe(second.body.id);
    const beforeCloseout = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM orders WHERE tenant_id=${tenantId} AND customer_id=${customerId}) AS orders,
      (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.tenant_id=${tenantId}) AS items,
      (SELECT count(*)::int FROM inventory_reservations r JOIN orders o ON o.id=r.order_id WHERE o.tenant_id=${tenantId} AND r.status='reserved') AS reservations,
      (SELECT COALESCE(SUM(quantity),0)::numeric FROM inventory_reservations WHERE catalog_item_id=${catalogItemId} AND status='reserved') AS reserved_quantity,
      (SELECT quantity_on_hand::numeric FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId}) AS qoh,
      (SELECT count(*)::int FROM inventory_movements WHERE tenant_id=${tenantId} AND movement_type='sale') AS sales,
      (SELECT count(*)::int FROM cash_ledger_entries WHERE tenant_id=${tenantId}) AS ledger`);
    expect(beforeCloseout.rows[0]).toMatchObject({ orders: 1, items: 1, reservations: 1, sales: 0, ledger: 0 });
    expect(Number(beforeCloseout.rows[0]?.reserved_quantity)).toBe(1);
    expect(Number(beforeCloseout.rows[0]?.qoh)).toBe(10);
    const replay = await as("customer").post("/api/orders").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const settled = await as("csr").post(`/api/orders/${first.body.id}/closeout`).send({ paymentMethod: "cash", amountTendered: Number(first.body.total).toFixed(2), idempotencyKey: `tax-e2e-replay-${first.body.id}` });
    expect(settled.status, settled.text).toBe(200);
    const orderReplay = await as("customer").post("/api/orders").send(body);
    expect(orderReplay.status).toBe(200);
    expect(orderReplay.body.id).toBe(first.body.id);
    const changed = await as("customer").post("/api/orders").send({ ...body, checkoutConfirmation: { ...confirmation, paymentMethod: "paypal" } });
    expect(changed.status).toBe(409);
    const sameToken = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id=${tenantId} AND customer_id=${customerId} AND checkout_conversion_snapshot->>'checkoutConversionToken'=${converted.body.checkoutConversionToken}`);
    expect(sameToken.rows[0]?.n).toBe(1);
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id=${tenantId} AND order_id=${first.body.id} AND movement_type='sale'`);
    expect(sales.rows).toHaveLength(1);
    const afterCloseout = await db.execute(sql`SELECT
      (SELECT quantity_on_hand::numeric FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogItemId}) AS qoh,
      (SELECT count(*)::int FROM orders WHERE tenant_id=${tenantId} AND customer_id=${customerId}) AS orders,
      (SELECT count(*)::int FROM inventory_movements WHERE tenant_id=${tenantId} AND order_id=${Number(first.body.id)} AND movement_type='sale') AS sales,
      (SELECT count(*)::int FROM cash_ledger_entries WHERE tenant_id=${tenantId} AND order_id=${Number(first.body.id)}) AS ledger`);
    expect(afterCloseout.rows[0]).toMatchObject({ orders: 1, sales: 1, ledger: 1 });
    expect(Number(afterCloseout.rows[0]?.qoh)).toBe(9);
  }, 60_000);

  it("authoritatively allocates PayPal tax after Customer Credit and replays without a second provider order", async () => {
    const provider = { createOrder: vi.fn(async ({ amount }: { amount: { value: string; currency: string } }) => ({ id: `TEST-PAYPAL-${amount.value}`, amount, approvalUrl: "https://example.test/approval" })) };
    const service = new PaymentService({ enabled: true, environment: "sandbox" } as never, provider as never);
    const taxSettings = await getCheckoutTaxSettings(tenantId);
    const taxSnapshot = { schemaVersion: 3, pendingTender: true, taxConfigurationId: taxSettings.taxConfigurationId, jurisdiction: taxSettings.taxJurisdiction, taxRate: taxSettings.taxRate, effectiveTaxRate: taxSettings.taxRate, locationId: null };
    for (const [credit, expectedTax, expectedDue] of [["0.00", "8.75", "108.75"], ["40.00", "8.75", "68.75"]]) {
      const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", grossSubtotal: "100.00", taxableSubtotal: "100.00", tax: "0.00", total: "100.00", customerCreditApplied: credit, remainingTenderAmount: credit === "0.00" ? "100.00" : "60.00", selectedPaymentMethod: "paypal", taxSnapshot, checkoutConversionSnapshot: { pricingSnapshot: { subtotal: 100, tax: 0, total: 100 } }, legalDisclaimerAccepted: true, finalConfirmationAt: new Date(), financialFinalizedAt: null }).returning();
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
    const taxSettings = await getCheckoutTaxSettings(tenantId);
    const taxSnapshot = { schemaVersion: 3, pendingTender: true, taxConfigurationId: taxSettings.taxConfigurationId, jurisdiction: taxSettings.taxJurisdiction, taxRate: taxSettings.taxRate, effectiveTaxRate: taxSettings.taxRate, locationId: null };
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", grossSubtotal: "100.00", taxableSubtotal: "100.00", tax: "0.00", total: "100.00", remainingTenderAmount: "100.00", selectedPaymentMethod: "paypal", taxSnapshot, checkoutConversionSnapshot: { pricingSnapshot: { subtotal: 100, tax: 0, total: 100 } }, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() }).returning();
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
    const captureSpy = vi.spyOn(PayPalProvider.prototype, "captureOrder").mockImplementation(async () => ({ orderId: "TEST-HTTP-PAYPAL-ORDER", captureId: "TEST-HTTP-PAYPAL-CAPTURE", status: "COMPLETED", amount: { value: "108.25", currency: "USD" }, fundingSource: "paypal" }));
    try {
      const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable)
        .where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
      expect(location).toBeDefined();
      const [locationTax] = await db.insert(taxConfigurationsTable).values({
        tenantId,
        locationId: location.id,
        jurisdiction: "Location Test",
        rate: "0.08250000",
        sourcingRule: "pickup",
        effectiveFrom: "2020-01-01",
        sourceName: "Test fixture",
        sourceUrl: "https://example.test/location-tax",
        verifiedAt: new Date(),
        verifiedByUserId: csrId,
      }).returning();
      locationTaxConfigurationId = locationTax.id;
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "paypal" };
      const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
      expect(converted.status, converted.text).toBe(200);
      const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "paypal" });
      expect(quote.status, quote.text).toBe(200);
      expect(quote.body).toMatchObject({ customerTax: 8.25, effectiveTaxRate: 0.0825, finalAmountDue: 108.25, tenderDue: 108.25 });
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ subtotal: 100, tax: quote.body.customerTax, total: quote.body.finalAmountDue });
      const orderId = Number(created.body.id);
      const initialSnapshot = await db.execute(sql`SELECT tax_collected, tender, tax_configuration_id, location_id FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
      expect(initialSnapshot.rows[0]).toMatchObject({ tax_collected: "8.25", tender: "paypal", tax_configuration_id: locationTax.id });
      expect(initialSnapshot.rows[0].location_id).toBe(location.id);
      expect((await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)))[0].taxSnapshot).toMatchObject({ locationId: location.id, taxConfigurationId: locationTax.id, taxRate: 0.0825 });
      // Once an order owns an immutable tax snapshot, a later settings edit
      // cannot change the amount or tax configuration used at settlement.
      await db.update(taxConfigurationsTable).set({ rate: "0.10000000" }).where(eq(taxConfigurationsTable.id, locationTax.id));
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
      const finalSnapshot = await db.execute(sql`SELECT tax_collected, tender, tax_configuration_id, location_id FROM order_tax_snapshots WHERE tenant_id = ${tenantId} AND order_id = ${orderId}`);
      expect(finalSnapshot.rows).toEqual(initialSnapshot.rows);
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      expect(order).toMatchObject({ paymentStatus: "paid", tax: "8.25", total: "108.25" });
    } finally {
      createSpy.mockRestore(); captureSpy.mockRestore();
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 60_000);

  it("calculates configured tax after updating a taxable cash item price", async () => {
    await db.update(catalogItemsTable).set({ price: "108.00" }).where(eq(catalogItemsTable.id, catalogItemId));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 108, tax: 9.45, total: 117.45 });
    const orderId = Number(created.body.id);
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "117.45", idempotencyKey: `tax-e2e-108-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ subtotal: 108, tax: 9.45, total: 117.45, cash: { amountDue: "117.45", amountTendered: "117.45", changeGiven: "0.00" } });
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    const [ledger] = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.orderId, orderId)));
    expect(stored).toMatchObject({ subtotal: "108.00", tax: "9.45", total: "117.45", remainingTenderAmount: "117.45", paymentStatus: "paid" });
    expect(ledger).toMatchObject({ amount: "117.45", amountTendered: "117.45", changeGiven: "0.00" });
  }, 60_000);

  it("fails closed when only another tenant has tax configuration and location", async () => {
    const [existingConfig] = await db.select().from(taxConfigurationsTable).where(eq(taxConfigurationsTable.tenantId, tenantId)).limit(1);
    expect(existingConfig).toBeDefined();
    const [otherOwner] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.tenantId, otherTenantId)).limit(1);
    const [otherLocation] = await db.insert(inventoryLocationsTable).values({ tenantId: otherTenantId, type: "storefront", name: "Other Tenant Tax Location", displayOrder: 1 }).returning();
    await db.insert(taxConfigurationsTable).values([
      { tenantId: otherTenantId, jurisdiction: "Other Tenant Global", rate: "0.08000000", sourcingRule: "tenant", effectiveFrom: "2020-01-01", sourceName: "Synthetic isolation fixture", sourceUrl: "https://example.test/other-global-tax", verifiedAt: new Date(), verifiedByUserId: otherOwner.id },
      { tenantId: otherTenantId, locationId: otherLocation.id, jurisdiction: "Other Tenant Location", rate: "0.08750000", sourcingRule: "pickup", effectiveFrom: "2020-01-01", sourceName: "Synthetic isolation fixture", sourceUrl: "https://example.test/other-location-tax", verifiedAt: new Date(), verifiedByUserId: otherOwner.id },
    ]).returning();
    const beforeOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}`);
    const beforeSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${tenantId}`);
    const beforeMovements = await db.execute(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = ${tenantId}`);
    const beforePayments = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.tenantId, tenantId));
    const otherBeforeOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${otherTenantId}`);
    const otherBeforeSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${otherTenantId}`);
    const otherBeforeMovements = await db.execute(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = ${otherTenantId}`);
    const otherBeforePayments = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.tenantId, otherTenantId));
    const otherBeforeBalances = await db.select({ productId: inventoryBalancesTable.productId, locationId: inventoryBalancesTable.locationId, quantityOnHand: inventoryBalancesTable.quantityOnHand }).from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, otherTenantId));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    try {
      await db.delete(taxConfigurationsTable).where(eq(taxConfigurationsTable.id, existingConfig.id));
      await expect(getCheckoutTaxSettings(tenantId, otherLocation.id)).rejects.toThrow();
      const quote = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash" });
      expect(quote.status).toBe(422);
      expect(quote.body.error).toBe("CHECKOUT_QUOTE_UNAVAILABLE");
      const crossLocation = await as("customer").post("/api/checkout/quote").send({ items, paymentMethod: "cash", locationId: otherLocation.id });
      expect(crossLocation.status).toBe(400);
      const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
      expect(created.status).toBe(422);
      expect(created.body.error).toBe("TAX_CONFIGURATION_UNAVAILABLE");
    } finally {
      await db.insert(taxConfigurationsTable).values({ tenantId: existingConfig.tenantId, locationId: existingConfig.locationId, jurisdiction: existingConfig.jurisdiction, rate: existingConfig.rate, sourcingRule: existingConfig.sourcingRule, effectiveFrom: existingConfig.effectiveFrom, effectiveUntil: existingConfig.effectiveUntil, sourceName: existingConfig.sourceName, sourceUrl: existingConfig.sourceUrl, verifiedAt: existingConfig.verifiedAt, verifiedByUserId: existingConfig.verifiedByUserId });
      await db.delete(taxConfigurationsTable).where(eq(taxConfigurationsTable.tenantId, otherTenantId));
      await db.delete(inventoryLocationsTable).where(eq(inventoryLocationsTable.id, otherLocation.id));
    }
    const afterOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}`);
    const afterSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${tenantId}`);
    const afterMovements = await db.execute(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = ${tenantId}`);
    const afterPayments = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.tenantId, tenantId));
    const otherAfterOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${otherTenantId}`);
    const otherAfterSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${otherTenantId}`);
    const otherAfterMovements = await db.execute(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = ${otherTenantId}`);
    const otherAfterPayments = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.tenantId, otherTenantId));
    const otherAfterBalances = await db.select({ productId: inventoryBalancesTable.productId, locationId: inventoryBalancesTable.locationId, quantityOnHand: inventoryBalancesTable.quantityOnHand }).from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, otherTenantId));
    expect(afterOrders.rows[0]?.n).toBe(beforeOrders.rows[0]?.n);
    expect(afterSnapshots.rows[0]?.n).toBe(beforeSnapshots.rows[0]?.n);
    expect(afterMovements.rows[0]?.n).toBe(beforeMovements.rows[0]?.n);
    expect(afterPayments).toEqual(beforePayments);
    expect(otherAfterOrders.rows[0]?.n).toBe(otherBeforeOrders.rows[0]?.n);
    expect(otherAfterSnapshots.rows[0]?.n).toBe(otherBeforeSnapshots.rows[0]?.n);
    expect(otherAfterMovements.rows[0]?.n).toBe(otherBeforeMovements.rows[0]?.n);
    expect(otherAfterPayments).toEqual(otherBeforePayments);
    expect(otherAfterBalances).toEqual(otherBeforeBalances);
  }, 60_000);

  it("serializes competing checkouts and rejects the one that would oversell", async () => {
    const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable)
      .where(eq(inventoryLocationsTable.tenantId, tenantId)).limit(1);
    const [balance] = await db.select().from(inventoryBalancesTable).where(and(
      eq(inventoryBalancesTable.tenantId, tenantId),
      eq(inventoryBalancesTable.productId, catalogItemId),
      eq(inventoryBalancesTable.locationId, location.id),
    )).limit(1);
    const [catalog] = await db.select({ stockQuantity: catalogItemsTable.stockQuantity, inventoryAmount: catalogItemsTable.inventoryAmount }).from(catalogItemsTable).where(eq(catalogItemsTable.id, catalogItemId));
    expect(balance).toBeDefined();
    const beforeOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}`);
    const beforeMovements = await db.execute(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalogItemId} AND movement_type = 'sale'`);
    const beforeSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${tenantId}`);
    await db.update(inventoryBalancesTable).set({ quantityOnHand: "1" }).where(eq(inventoryBalancesTable.id, balance.id));
    await db.update(catalogItemsTable).set({ stockQuantity: "1", inventoryAmount: "1" }).where(eq(catalogItemsTable.id, catalogItemId));
    try {
      const items = [{ catalogItemId, quantity: 1 }];
      const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
      const conversions = await Promise.all([
        as("customer").post("/api/cart/convert").send({ items, confirmation }),
        as("customer").post("/api/cart/convert").send({ items, confirmation }),
      ]);
      for (const converted of conversions) expect(converted.status, converted.text).toBe(200);
      const submissions = conversions.map(converted => as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" }));
      const results = await Promise.all(submissions);
      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      const winner = results.find(result => result.status === 201)!;
      const loser = results.find(result => result.status === 409)!;
      expect(loser.body).toMatchObject({ legacyError: "Insufficient inventory" });
      const afterOrders = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}`);
      expect(afterOrders.rows[0]?.n).toBe(Number(beforeOrders.rows[0]?.n) + 1);
      const winnerPayments = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable).where(eq(paymentAttemptsTable.orderId, Number(winner.body.id)));
      expect(winnerPayments).toHaveLength(0);
      const winnerCashLedger = await db.select({ id: cashLedgerEntriesTable.id }).from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.orderId, Number(winner.body.id))));
      expect(winnerCashLedger).toHaveLength(0);
      const winnerSnapshots = await db.execute(sql`SELECT id FROM order_tax_snapshots WHERE tenant_id=${tenantId} AND order_id=${Number(winner.body.id)}`);
      expect(winnerSnapshots.rows).toHaveLength(1);
      const afterMovements = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalogItemId} AND movement_type = 'sale'`);
      expect(afterMovements.rows).toHaveLength(Number(beforeMovements.rows[0]?.n));
      const winnerMovements = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id=${tenantId} AND order_id=${Number(winner.body.id)} AND movement_type='sale'`);
      expect(winnerMovements.rows).toHaveLength(0);
      const afterSnapshots = await db.execute(sql`SELECT count(*)::int AS n FROM order_tax_snapshots WHERE tenant_id = ${tenantId}`);
      expect(afterSnapshots.rows[0]?.n).toBe(Number(beforeSnapshots.rows[0]?.n) + 1);
      const [remaining] = await db.select({ quantityOnHand: inventoryBalancesTable.quantityOnHand }).from(inventoryBalancesTable).where(eq(inventoryBalancesTable.id, balance.id));
      expect(Number(remaining.quantityOnHand)).toBe(1);
      const active = await db.select({ id: inventoryReservationsTable.id, quantity: inventoryReservationsTable.quantity }).from(inventoryReservationsTable)
        .innerJoin(ordersTable, eq(ordersTable.id, inventoryReservationsTable.orderId))
        .where(and(eq(ordersTable.tenantId, tenantId), eq(inventoryReservationsTable.catalogItemId, catalogItemId), eq(inventoryReservationsTable.status, "reserved")));
      expect(active).toHaveLength(1);
      expect(active[0]?.quantity).toBe("1.000000");
    } finally {
      await db.update(inventoryBalancesTable).set({ quantityOnHand: balance.quantityOnHand }).where(eq(inventoryBalancesTable.id, balance.id));
      await db.update(catalogItemsTable).set({ stockQuantity: catalog.stockQuantity, inventoryAmount: catalog.inventoryAmount }).where(eq(catalogItemsTable.id, catalogItemId));
    }
  }, 60_000);
});
