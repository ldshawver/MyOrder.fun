/** Runs only against an explicitly named disposable, migrated PostgreSQL clone. */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { and, eq, sql } from "drizzle-orm";

const people = vi.hoisted(() => ({
  customer: { clerkId: "tax_e2e_customer", email: "customer@tax-e2e.test", role: "user" },
  csr: { clerkId: "tax_e2e_csr", email: "csr@tax-e2e.test", role: "csr" },
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
import { adminSettingsTable, catalogItemsTable, cashLedgerEntriesTable, csrBoxesTable, customerDisclaimerAcceptancesTable, db, inventoryBalancesTable, inventoryLocationsTable, labTechShiftsTable, ordersTable, paymentAttemptsTable, pool, taxConfigurationsTable, tenantsTable, usersTable } from "@workspace/db";
import { PaymentService } from "../payments/service";
import { adjustCustomerCredit } from "../payments/customerCredit";

const integrationDescribe = process.env.RUN_TENDER_TAX_INTEGRATION === "1" ? describe : describe.skip;
integrationDescribe("Cash tender tax via conversion, order, and closeout routes", () => {
  let server: Server | undefined;
  let request: ReturnType<typeof supertest>;
  let catalogItemId: number;
  let tenantId: number;
  let customerId: number;
  let csrId: number;
  const as = (who: keyof typeof people) => ({
    post: (path: string) => request.post(path).set("x-tax-e2e-user", who),
  });

  beforeAll(async () => {
    if (!/^postgresql:\/\/[^@]+@(?:127\.0\.0\.1|localhost):32778\/myorder_tax_production_like$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Disposable tax clone required");
    const target = await db.execute(sql`SELECT current_database() AS name`);
    if (target.rows[0]?.name !== "myorder_tax_production_like") throw new Error("Disposable tax clone required");
    await db.execute(sql`TRUNCATE TABLE ${tenantsTable} RESTART IDENTITY CASCADE`);
    const [tenant] = await db.insert(tenantsTable).values({ name: "Tax E2E Tenant", slug: "tax-e2e-tenant", status: "active" }).returning();
    tenantId = tenant.id;
    await db.insert(adminSettingsTable).values({ tenantId: tenant.id, enabledProcessors: ["cash", "paypal"], orderRoutingRule: "round_robin", customerDisclaimerVersion: 1, customerDisclaimerText: "All sales are final. Confirm before checkout." });
    const [customer, csr] = await db.insert(usersTable).values([
      { clerkId: people.customer.clerkId, email: people.customer.email, normalizedEmail: people.customer.email, firstName: "Pat", lastName: "E2E", role: "user", tenantId: tenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: people.csr.clerkId, email: people.csr.email, normalizedEmail: people.csr.email, firstName: "Casey", lastName: "E2E", role: "csr", tenantId: tenant.id, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
    ]).returning();
    customerId = customer.id;
    csrId = csr.id;
    await db.insert(taxConfigurationsTable).values({ tenantId, jurisdiction: "Test", rate: "0.08750000", sourcingRule: "tenant", effectiveFrom: "2020-01-01", sourceName: "Test fixture", sourceUrl: "https://example.test/tax", verifiedAt: new Date(), verifiedByUserId: csr.id });
    await db.insert(customerDisclaimerAcceptancesTable).values({ tenantId: tenant.id, userId: customer.id, disclaimerVersion: 1 });
    const [box] = await db.insert(csrBoxesTable).values({ tenantId: tenant.id, slug: "sales-box-1", label: "CSR Sales Box 1", displayOrder: 1 }).returning();
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId: tenant.id, type: "csr_box", csrBoxId: box.id, name: "CSR Sales Box 1", displayOrder: 1 }).returning();
    await db.insert(labTechShiftsTable).values({ tenantId: tenant.id, techId: csr.id, status: "active", boxAssignmentId: box.slug, cashBankStart: "100.00", setupJson: { boxAssignmentId: box.slug, inventoryConfirmed: true, parLevelsConfirmed: true, printerAssigned: true } });
    const [item] = await db.insert(catalogItemsTable).values({ tenantId: tenant.id, name: "Taxable $100 Fixture", description: "Neutral test product", category: "Fixtures", sku: "TAX-E2E-100", price: "100.00", isTaxable: true, stockQuantity: "10", inventoryAmount: "10", isAvailable: true, alavontName: "Taxable $100 Fixture", alavontDescription: "Neutral test product", alavontCategory: "Fixtures", alavontId: "TAX-E2E-100", alavontInStock: true, luciferCruzName: "Taxable $100 Fixture", luciferCruzDescription: "Neutral test product", luciferCruzCategory: "Fixtures", displayName: "Taxable $100 Fixture", displayDescription: "Neutral test product", displayCategory: "Fixtures", merchantBrandName: "Lucifer Cruz", customerSafeName: "Taxable $100 Fixture", customerSafeDescription: "Neutral test product", merchantName: "Taxable $100 Fixture", merchantDescription: "Neutral test product", merchantCategory: "Fixtures", merchantSku: "TAX-E2E-100", merchantBrand: "alavont", merchantProductSource: "local_mapped", merchantProcessingMode: "mapped_lucifer", receiptName: "Taxable $100 Fixture", labelName: "Taxable $100 Fixture", labName: "Taxable $100 Fixture" }).returning();
    catalogItemId = item.id;
    await db.insert(inventoryBalancesTable).values({ tenantId: tenant.id, productId: item.id, locationId: location.id, quantityOnHand: "10", parLevel: "2" });
    server = app.listen(0);
    request = supertest(server);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });

  it("settles a taxable $100 Cash order for exactly $100 once", async () => {
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "cash" };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const hostile = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup", tax: 0.01, total: 0.01 });
    expect(hostile.status).toBeGreaterThanOrEqual(400);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ subtotal: 100, tax: 0, total: 100 });
    const orderId = Number(created.body.id);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    expect(order).toMatchObject({ subtotal: "100.00", tax: "0.00", total: "100.00", remainingTenderAmount: "100.00" });
    const closed = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "100.00", idempotencyKey: `tax-e2e-${orderId}` });
    expect(closed.status, closed.text).toBe(200);
    const ledger = await db.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.orderId, orderId), eq(cashLedgerEntriesTable.tenantId, order.tenantId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe("100.00");
    const replay = await as("csr").post(`/api/orders/${orderId}/closeout`).send({ paymentMethod: "cash", amountTendered: "100.00", idempotencyKey: `tax-e2e-${orderId}` });
    expect(replay.status, replay.text).toBe(200);
    expect(await db.select().from(cashLedgerEntriesTable).where(eq(cashLedgerEntriesTable.orderId, orderId))).toHaveLength(1);
  }, 60_000);

  it("pays a taxable $100 cart entirely with Customer Credit and adds no tax", async () => {
    await db.transaction(tx => adjustCustomerCredit(tx, { tenantId, customerId, actorUserId: csrId, amountCents: 10000, reason: "Disposable tax test fixture", idempotencyKey: "tax-e2e-credit-funding" }));
    const items = [{ catalogItemId, quantity: 1 }];
    const confirmation = { acceptedAllSalesFinal: true, confirmedAt: new Date().toISOString(), legalDisclaimerText: "All sales are final. Confirm before checkout.", paymentMethod: "customer_credit", customerCreditAmount: 100 };
    const converted = await as("customer").post("/api/cart/convert").send({ items, confirmation });
    expect(converted.status, converted.text).toBe(200);
    const created = await as("customer").post("/api/orders").send({ orderType: "WALK_IN", items, checkoutConversionToken: converted.body.checkoutConversionToken, checkoutConversionSnapshot: converted.body, checkoutConfirmation: confirmation, deliveryMethod: "pickup" });
    expect(created.status, created.text).toBe(201);
    const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(created.body.id))).limit(1);
    expect(stored).toMatchObject({ subtotal: "100.00", tax: "0.00", total: "100.00", customerCreditApplied: "100.00", remainingTenderAmount: "0.00", paymentStatus: "paid" });
    const sales = await db.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND order_id = ${stored.id} AND movement_type = 'sale'`);
    expect(sales.rows).toHaveLength(1);
  }, 60_000);

  it("authoritatively allocates PayPal tax after Customer Credit and replays without a second provider order", async () => {
    const provider = { createOrder: vi.fn(async ({ amount }: { amount: { value: string; currency: string } }) => ({ id: `TEST-PAYPAL-${amount.value}`, amount, approvalUrl: "https://example.test/approval" })) };
    const service = new PaymentService({ enabled: true, environment: "sandbox" } as never, provider as never);
    for (const [credit, expectedTax, expectedDue] of [["0.00", "8.75", "108.75"], ["40.00", "5.25", "65.25"]]) {
      const [order] = await db.insert(ordersTable).values({ tenantId, customerId, subtotal: "100.00", grossSubtotal: "100.00", taxableSubtotal: "100.00", tax: "0.00", total: "100.00", customerCreditApplied: credit, remainingTenderAmount: credit === "0.00" ? "100.00" : "60.00", selectedPaymentMethod: "paypal", taxSnapshot: { schemaVersion: 3, pendingTender: true }, checkoutConversionSnapshot: { pricingSnapshot: { subtotal: 100, tax: 0, total: 100 } }, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() }).returning();
      const first = await service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: `tax-e2e-paypal-${order.id}` });
      expect(first.replayed).toBe(false);
      const [stored] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id)).limit(1);
      expect(stored).toMatchObject({ tax: expectedTax, total: credit === "0.00" ? "108.75" : "105.25", remainingTenderAmount: expectedDue });
      expect(stored.taxSnapshot).toMatchObject({ schemaVersion: 3, taxRate: 0.0875, customerTaxCollected: Number(expectedTax), pendingTender: false });
      expect((stored.checkoutConversionSnapshot as { pricingSnapshot?: { tax?: number; total?: number } })?.pricingSnapshot).toMatchObject({ tax: Number(expectedTax), total: Number(stored.total) });
      const [attempt] = await db.select().from(paymentAttemptsTable).where(eq(paymentAttemptsTable.orderId, order.id)).limit(1);
      expect(attempt.requestedAmount).toBe(expectedDue);
      const replay = await service.create({ tenantId, customerId, orderId: order.id, idempotencyKey: `tax-e2e-paypal-${order.id}` });
      expect(replay.replayed).toBe(true);
    }
    expect(provider.createOrder).toHaveBeenCalledTimes(2);
  }, 60_000);
});
