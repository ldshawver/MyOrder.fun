/**
 * Regression: an approved, active, verified, provisioned customer whose row
 * predates approval provenance must be able to check out through the REAL
 * application (`../../app` — the production router composition and mount
 * order), not just through an isolated orders router or a policy helper.
 *
 * Production failure this guards against: POST /api/orders (and the other
 * customer checkout calls) returned 403 "Account approval provenance
 * required" because a router mounted earlier in routes/index.ts installed a
 * path-less `requireApproved` guard that ran before the orders router's
 * customer checkout policy could apply.
 *
 * Requires the full Drizzle schema in a disposable local PostgreSQL 16
 * database whose name starts with `myorder_p0_owner_approval_`. Set
 * MYORDER_CHECKOUT_DATABASE_URL to run it; it is skipped otherwise.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";

type Identity = { clerkId: string; email: string };
const identities = vi.hoisted(() => ({
  legacyCustomer: { clerkId: "checkout_legacy_customer", email: "legacy-customer@checkout.invalid" },
  pendingCustomer: { clerkId: "checkout_pending_customer", email: "pending-customer@checkout.invalid" },
  inactiveCustomer: { clerkId: "checkout_inactive_customer", email: "inactive-customer@checkout.invalid" },
  unverifiedCustomer: { clerkId: "checkout_unverified_customer", email: "unverified-customer@checkout.invalid" },
  unprovisionedCustomer: { clerkId: "checkout_unprovisioned_customer", email: "unprovisioned-customer@checkout.invalid" },
  rejectedCustomer: { clerkId: "checkout_rejected_customer", email: "rejected-customer@checkout.invalid" },
  staffWithoutProvenance: { clerkId: "checkout_staff_no_provenance", email: "staff@checkout.invalid" },
}) as Record<string, Identity>);

// Clerk is mocked to return a signed-in subject with NO organization claims
// and NO approval metadata: checkout must not depend on either.
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: { header(name: string): string | undefined }) => {
    const key = req.header("x-checkout-test-user");
    const identity = key ? identities[key] : undefined;
    if (!identity) return { userId: null, sessionClaims: {} };
    return { userId: identity.clerkId, sessionClaims: { email: identity.email } };
  },
  clerkClient: {
    users: {
      getUser: vi.fn(async (clerkId: string) => {
        const identity = Object.values(identities).find(candidate => candidate.clerkId === clerkId);
        if (!identity) throw new Error(`unknown checkout test identity: ${clerkId}`);
        return {
          id: identity.clerkId,
          emailAddresses: [{ id: `email_${clerkId}`, emailAddress: identity.email, verification: { status: "verified" } }],
          primaryEmailAddressId: `email_${clerkId}`,
          publicMetadata: {},
        };
      }),
      updateUser: vi.fn(),
      updateUserMetadata: vi.fn(),
    },
  },
}));

const databaseUrl = process.env.MYORDER_CHECKOUT_DATABASE_URL;
const pgSuite = databaseUrl ? describe : describe.skip;

pgSuite("customer checkout through the production route composition (PostgreSQL 16)", () => {
  let server: Server | undefined;
  let request: ReturnType<typeof supertest>;
  let dbModule: typeof import("@workspace/db");
  let tenantId: number;
  let otherTenantId: number;
  let catalogItemId: number;
  let legacyCustomerId: number;
  let disclaimerText: string;
  let pickupLocationId: number;

  const as = (who: keyof typeof identities) => ({
    get: (path: string) => request.get(path).set("x-checkout-test-user", who),
    post: (path: string) => request.post(path).set("x-checkout-test-user", who),
  });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/^(localhost|127\.0\.0\.1|::1)$/.test(parsed.hostname) || !/^myorder_p0_owner_approval_/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new Error("Refusing non-local database outside the disposable myorder_p0_owner_approval_ fixture");
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = "false";
    process.env.MYORDER_OWNER_CLERK_ID = "checkout_owner_fixture";

    dbModule = await import("@workspace/db");
    const { db, pool, tenantsTable, usersTable, adminSettingsTable, catalogItemsTable, inventoryLocationsTable, inventoryBalancesTable } = dbModule;
    const version = await pool.query<{ version: number }>("SELECT current_setting('server_version_num')::int AS version");
    if (version.rows[0]!.version < 160000 || version.rows[0]!.version >= 170000) throw new Error("Expected PostgreSQL 16");
    await pool.query("TRUNCATE TABLE tenants RESTART IDENTITY CASCADE");

    const [tenant] = await db.insert(tenantsTable).values({ name: "Checkout House", slug: "checkout-house", status: "active" }).returning();
    const [otherTenant] = await db.insert(tenantsTable).values({ name: "Checkout Other", slug: "checkout-other", status: "active" }).returning();
    tenantId = tenant.id;
    otherTenantId = otherTenant.id;
    process.env.MYORDER_SIGNUP_TENANT_ID = String(tenantId);

    disclaimerText = "All sales are final. Confirm this order before checkout.";
    await db.insert(adminSettingsTable).values({
      tenantId,
      customerDisclaimerText: disclaimerText,
      customerDisclaimerVersion: 1,
      enabledProcessors: ["cash"],
      wcEnabled: false,
    });

    // Fully valid customer whose row predates approval provenance: no
    // approver, no approval timestamp, no Clerk org membership anywhere.
    const customerRow = (clerkKey: keyof typeof identities, overrides: Record<string, unknown> = {}) => ({
      clerkId: identities[clerkKey].clerkId,
      email: identities[clerkKey].email,
      normalizedEmail: identities[clerkKey].email,
      firstName: "Checkout",
      lastName: String(clerkKey),
      role: "user",
      tenantId,
      status: "approved",
      isActive: true,
      identityStatus: "verified",
      provisioningStatus: "active",
      approvedByClerkId: null,
      approvedAt: null,
      ...overrides,
    });
    const inserted = await db.insert(usersTable).values([
      customerRow("legacyCustomer"),
      customerRow("pendingCustomer", { status: "pending" }),
      customerRow("inactiveCustomer", { isActive: false }),
      customerRow("unverifiedCustomer", { identityStatus: "verification_pending" }),
      customerRow("unprovisionedCustomer", { provisioningStatus: "pending" }),
      customerRow("rejectedCustomer", { status: "rejected" }),
      customerRow("staffWithoutProvenance", { role: "csr" }),
    ] as Array<typeof usersTable.$inferInsert>).returning();
    legacyCustomerId = inserted.find(row => row.clerkId === identities.legacyCustomer.clerkId)!.id;
    await pool.query(
      `INSERT INTO tax_configurations(tenant_id,jurisdiction,rate,sourcing_rule,effective_from,source_name,source_url,verified_at,verified_by_user_id)
       VALUES($1,'Fixture County',0.1,'tenant',CURRENT_DATE - 1,'fixture','https://example.invalid/tax',now(),$2)`,
      [tenantId, legacyCustomerId],
    );

    const [item] = await db.insert(catalogItemsTable).values({
      tenantId,
      name: "Checkout Item",
      description: "Internal description",
      category: "Internal",
      sku: "CHK-1",
      price: "20.00",
      stockQuantity: "3",
      inventoryAmount: "3",
      isAvailable: true,
      alavontName: "Checkout Item",
      alavontDescription: "Customer description",
      alavontCategory: "Menu",
      alavontId: "CHK-ALV-1",
      alavontInStock: true,
      luciferCruzName: "Merchant Checkout Item",
      luciferCruzDescription: "Merchant-safe description",
      luciferCruzCategory: "Merchant Goods",
      displayName: "Checkout Item",
      customerSafeName: "Merchant Checkout Item",
      customerSafeDescription: "Merchant-safe description",
      merchantName: "Merchant Checkout Item",
      merchantDescription: "Merchant-safe description",
      merchantCategory: "Merchant Goods",
      merchantSku: "CHK-MERCHANT-1",
      merchantBrand: "alavont",
      merchantProductSource: "local_mapped",
      merchantProcessingMode: "mapped_lucifer",
      receiptName: "Merchant Checkout Item",
      labelName: "Merchant Checkout Item",
      labName: "Checkout Item",
    }).returning();
    catalogItemId = item.id;
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "storefront", name: "Front", displayOrder: 1 }).returning();
    pickupLocationId = location.id;
    await db.insert(inventoryBalancesTable).values({ tenantId, productId: item.id, locationId: location.id, quantityOnHand: "3", parLevel: "1" });
    // The database derives the storefront catalogue product/option and its
    // inventory item from the catalogue row; checkout requires them active.
    const option = await pool.query("SELECT 1 FROM catalogue_options co JOIN catalogue_products cp ON cp.id = co.product_id WHERE co.tenant_id = $1 AND co.catalog_item_id = $2 AND co.active AND cp.active AND co.inventory_item_id IS NOT NULL", [tenantId, item.id]);
    if (option.rowCount !== 1) throw new Error("Expected an active storefront catalogue option for the checkout fixture item");
    // Pickup open all day, every day, so immediate pickup is always valid.
    const allDay = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, intervals: [{ open: "00:00", close: "23:59" }] }));
    await pool.query(
      "INSERT INTO location_pickup_schedules(tenant_id,location_id,time_zone,weekly_hours,exceptions,slot_minutes,max_advance_days,version) VALUES($1,$2,'UTC',$3::jsonb,'[]'::jsonb,15,7,1)",
      [tenantId, location.id, JSON.stringify(allDay)],
    );

    const { default: app } = await import("../../app");
    server = app.listen(0);
    request = supertest(server);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await dbModule?.pool.end();
  });

  const confirmation = () => ({ acceptedAllSalesFinal: true as const, confirmedAt: new Date().toISOString(), legalDisclaimerText: disclaimerText });

  async function convert(who: keyof typeof identities, quantity = 1) {
    return as(who).post("/api/cart/convert").send({ items: [{ catalogItemId, quantity }], confirmation: confirmation() });
  }

  /**
   * Mirrors the storefront (platform/src/pages/new-order.tsx): convert the
   * cart, obtain the server tax quote, then POST /api/orders with both tokens.
   */
  async function placeOrder(who: keyof typeof identities, options: {
    quantity?: number;
    orderQuantity?: number;
    paymentMethod?: "cash" | "paypal";
    confirmation?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {}) {
    const quantity = options.quantity ?? 1;
    const converted = await convert(who, quantity);
    expect(converted.status, converted.text).toBe(200);
    const quote = await as(who).post("/api/checkout/quote").send({
      items: [{ catalogItemId, quantity }], paymentMethod: "cash", deliveryMethod: "pickup", pickupLocationId,
    });
    expect(quote.status, quote.text).toBe(200);
    const confirmed = { ...confirmation(), paymentMethod: options.paymentMethod ?? "cash", checkoutTaxQuoteToken: quote.body.checkoutTaxQuoteToken, ...options.confirmation };
    return as(who).post("/api/orders").send({
      items: [{ catalogItemId, quantity: options.orderQuantity ?? quantity }],
      notes: "",
      checkoutConversionToken: converted.body.checkoutConversionToken,
      checkoutConversionSnapshot: converted.body,
      selectedPaymentMethod: options.paymentMethod ?? "cash",
      paymentMethod: options.paymentMethod ?? "cash",
      pickupLocationId,
      checkoutConfirmation: confirmed,
      ...options.extra,
    });
  }

  async function storedOrder(id: unknown) {
    const { db, ordersTable } = dbModule;
    const { eq } = await import("drizzle-orm");
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(id)));
    return order;
  }

  it("lets a fully valid customer without approval provenance or Clerk org claims complete checkout", async () => {
    const disclaimer = await as("legacyCustomer").get("/api/customer/disclaimer");
    expect(disclaimer.status, disclaimer.text).toBe(200);
    const accepted = await as("legacyCustomer").post("/api/customer/disclaimer/accept").send({ version: 1 });
    expect(accepted.status, accepted.text).toBe(201);
    const pickup = await as("legacyCustomer").get("/api/orders/pickup-availability");
    expect(pickup.status, pickup.text).toBe(200);
    const availability = await as("legacyCustomer").post("/api/cart/availability").send({ catalogItemId, quantity: 1 });
    expect(availability.status, availability.text).toBe(200);

    const created = await placeOrder("legacyCustomer");
    expect(created.status, created.text).toBe(201);

    // Server-side pricing: totals come from the catalogue price and the
    // tenant's tax configuration, never from the client.
    const order = await storedOrder(created.body.id);
    expect(order.tenantId).toBe(tenantId);
    expect(order.customerId).toBe(legacyCustomerId);
    expect(Number(order.subtotal)).toBe(20);
    expect(Number(order.tax)).toBe(2);
    expect(order.paymentStatus).toBe("unpaid");
    const { db, orderItemsTable, usersTable } = dbModule;
    const { eq } = await import("drizzle-orm");
    const lines = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
    expect(lines.map(line => [line.catalogItemId, line.quantity, Number(line.unitPrice)])).toEqual([[catalogItemId, 1, 20]]);

    // The fix must not fabricate approval provenance on the account.
    const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, legacyCustomerId));
    expect(customer.approvedByClerkId).toBeNull();
    expect(customer.approvedAt).toBeNull();
    expect(customer.status).toBe("approved");
  });

  describe("order creation still enforces server-side checkout rules", () => {
    it("never honors client-supplied prices or totals", async () => {
      const res = await placeOrder("legacyCustomer", { extra: { subtotal: 0.01, total: 0.01, items: [{ catalogItemId, quantity: 1, unitPrice: 0.01 }] } });
      if (res.status === 201) {
        const order = await storedOrder(res.body.id);
        expect(Number(order.subtotal)).toBe(20);
        expect(Number(order.tax)).toBe(2);
      } else {
        expect(res.status, res.text).toBe(400);
      }
    });

    it("requires final-sale confirmation", async () => {
      const res = await placeOrder("legacyCustomer", { confirmation: { acceptedAllSalesFinal: false } });
      expect(res.status, res.text).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.code).not.toBe("ACCOUNT_APPROVAL_PROVENANCE_REQUIRED");
    });

    it("requires a server-issued conversion matching the submitted cart", async () => {
      const res = await placeOrder("legacyCustomer", { orderQuantity: 2 });
      expect(res.status, res.text).toBe(422);
    });

    it("refuses quantities beyond available stock", async () => {
      const availability = await as("legacyCustomer").post("/api/cart/availability").send({ catalogItemId, quantity: 50 });
      expect(availability.status, availability.text).toBe(409);
      // Conversion does not freeze local stock; the order's reservation does.
      const res = await placeOrder("legacyCustomer", { quantity: 50 });
      expect([409, 422], res.text).toContain(res.status);
      const { db, ordersTable } = dbModule;
      const { sql } = await import("drizzle-orm");
      const oversized = await db.select().from(ordersTable).where(sql`${ordersTable.subtotal} >= 1000`);
      expect(oversized).toHaveLength(0);
    });

    it("refuses a payment processor the tenant has not enabled", async () => {
      const res = await placeOrder("legacyCustomer", { paymentMethod: "paypal" });
      expect(res.status, res.text).toBe(422);
    });
  });

  describe("strict denials on the checkout route", () => {
    const orderBody = () => ({
      orderType: "WALK_IN",
      items: [{ catalogItemId, quantity: 1 }],
      checkoutConfirmation: { ...confirmation(), paymentMethod: "cash" },
      deliveryMethod: "pickup",
    });

    it.each([
      ["pendingCustomer", "ACCOUNT_PENDING_APPROVAL"],
      ["inactiveCustomer", "ACCOUNT_DEACTIVATED"],
      ["rejectedCustomer", "ACCOUNT_REJECTED"],
      ["unverifiedCustomer", "ACCOUNT_IDENTITY_REQUIRED"],
      ["unprovisionedCustomer", "ACCOUNT_IDENTITY_REQUIRED"],
      ["staffWithoutProvenance", "ACCOUNT_APPROVAL_PROVENANCE_REQUIRED"],
    ] as const)("denies %s with %s", async (who, code) => {
      for (const call of [
        () => as(who).post("/api/orders").send(orderBody()),
        () => as(who).post("/api/cart/convert").send({ items: [{ catalogItemId, quantity: 1 }], confirmation: confirmation() }),
        () => as(who).post("/api/customer/disclaimer/accept").send({ version: 1 }),
      ]) {
        const res = await call();
        expect(res.status, res.text).toBe(403);
        expect(res.body.code).toBe(code);
      }
    });

    it("denies a cross-tenant checkout attempt", async () => {
      const res = await as("legacyCustomer").post("/api/orders").send({ ...orderBody(), tenantId: otherTenantId });
      expect(res.status, res.text).toBe(403);
      expect(res.body.error).toBe("Tenant assignment does not match");
    });

    it("denies unauthenticated checkout", async () => {
      const res = await request.post("/api/orders").send(orderBody());
      expect(res.status, res.text).toBe(401);
    });

    it("keeps staff-only endpoints behind full approval provenance", async () => {
      const res = await as("legacyCustomer").post(`/api/admin/catalogue/products/1/inventory-reconciliation/preview`).send({});
      expect(res.status, res.text).toBe(403);
    });
  });
});
