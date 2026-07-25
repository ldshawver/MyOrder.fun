import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { sql } from "drizzle-orm";

const identities = vi.hoisted(() => ({
  customer: { clerkId: "e2e_customer", email: "customer@pos-e2e.test", role: "user" },
  csr: { clerkId: "e2e_csr", email: "csr@pos-e2e.test", role: "csr" },
  admin: { clerkId: "e2e_admin", email: "admin@pos-e2e.test", role: "admin" },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: { header(name: string): string | undefined }) => {
    const key = req.header("x-pos-e2e-user") as keyof typeof identities | undefined;
    const identity = key ? identities[key] : undefined;
    if (!identity) return { userId: null, sessionClaims: {} };
    return {
      userId: identity.clerkId,
      sessionClaims: {
        email: identity.email,
        firstName: key === "customer" ? "Pat" : key === "csr" ? "Casey" : "Alex",
        lastName: "E2E",
        publicMetadata: { role: identity.role, status: "approved" },
      },
    };
  },
  clerkClient: {
    users: {
      getUser: vi.fn(async (clerkId: string) => {
        const identity = Object.values(identities).find(candidate => candidate.clerkId === clerkId);
        if (!identity) throw new Error(`unknown E2E Clerk identity: ${clerkId}`);
        return {
          id: identity.clerkId,
          emailAddresses: [{ id: `email_${identity.clerkId}`, emailAddress: identity.email, verification: { status: "verified" } }],
          primaryEmailAddressId: `email_${identity.clerkId}`,
          publicMetadata: { role: identity.role, status: "approved" },
        };
      }),
      updateUser: vi.fn(),
      updateUserMetadata: vi.fn(),
      updateUserProfileImage: vi.fn(),
    },
  },
}));

import app from "../app";
import {
  adminSettingsTable,
  catalogItemsTable,
  csrBoxesTable,
  db,
  inventoryBalancesTable,
  inventoryLocationsTable,
  inventoryTemplatesTable,
  pool,
  printSettingsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";

const operationalDescribe = process.env.RUN_POS_E2E === "1" ? describe : describe.skip;

operationalDescribe("POS opening-manager operational flow", () => {
  let server: Server | undefined;
  let request: ReturnType<typeof supertest>;
  let catalogItemId: number;

  const as = (identity: keyof typeof identities) => ({
    get: (path: string) => request.get(path).set("x-pos-e2e-user", identity),
    post: (path: string) => request.post(path).set("x-pos-e2e-user", identity),
  });

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE ${tenantsTable} RESTART IDENTITY CASCADE`);

    const [tenant] = await db.insert(tenantsTable).values({
      name: "POS E2E House",
      slug: "pos-e2e-house",
      status: "active",
    }).returning();

    await db.insert(adminSettingsTable).values({
      tenantId: tenant.id,
      orderRoutingRule: "round_robin",
      customerDisclaimerText: "All sales are final. Confirm this operational E2E order before checkout.",
      customerDisclaimerVersion: 1,
      wcEnabled: false,
    });
    await db.insert(printSettingsTable).values({
      autoPrintOrders: true,
      autoPrintReceipts: false,
      autoPrintLabels: false,
    });

    await db.insert(usersTable).values([
      {
        clerkId: identities.csr.clerkId,
        email: identities.csr.email,
        normalizedEmail: identities.csr.email,
        firstName: "Casey",
        lastName: "E2E",
        role: "csr",
        tenantId: tenant.id,
        status: "approved",
        identityStatus: "verified",
        provisioningStatus: "active",
      },
      {
        clerkId: identities.admin.clerkId,
        email: identities.admin.email,
        normalizedEmail: identities.admin.email,
        firstName: "Alex",
        lastName: "E2E",
        role: "admin",
        tenantId: tenant.id,
        status: "approved",
        identityStatus: "verified",
        provisioningStatus: "active",
      },
    ]);

    const [item] = await db.insert(catalogItemsTable).values({
      tenantId: tenant.id,
      name: "Internal E2E Item",
      description: "Internal operations description",
      category: "Internal",
      sku: "E2E-INTERNAL-1",
      price: "20.00",
      stockQuantity: "10",
      inventoryAmount: "10",
      isAvailable: true,
      alavontName: "E2E Customer Item",
      alavontDescription: "Customer-facing E2E description",
      alavontCategory: "E2E Menu",
      alavontId: "E2E-ALV-1",
      alavontInStock: true,
      luciferCruzName: "Merchant E2E Item",
      luciferCruzDescription: "Merchant-safe description",
      luciferCruzCategory: "Merchant Goods",
      displayName: "E2E Customer Item",
      displayDescription: "Customer-facing E2E description",
      displayCategory: "E2E Menu",
      merchantBrandName: "Lucifer Cruz",
      marketingCopy: "Operational E2E item",
      customerSafeName: "Merchant E2E Item",
      customerSafeDescription: "Merchant-safe description",
      merchantName: "Merchant E2E Item",
      merchantDescription: "Merchant-safe description",
      merchantCategory: "Merchant Goods",
      merchantSku: "E2E-MERCHANT-1",
      merchantBrand: "alavont",
      merchantProductSource: "local_mapped",
      merchantProcessingMode: "mapped_lucifer",
      receiptName: "Merchant E2E Item",
      labelName: "Merchant E2E Item",
      labName: "E2E Customer Item",
      parLevel: "2",
    }).returning();
    catalogItemId = item.id;

    const [box] = await db.insert(csrBoxesTable).values({
      tenantId: tenant.id,
      slug: "sales-box-1",
      label: "CSR Sales Box 1",
      displayOrder: 1,
    }).returning();
    const [location] = await db.insert(inventoryLocationsTable).values({
      tenantId: tenant.id,
      type: "csr_box",
      csrBoxId: box.id,
      name: "CSR Sales Box 1",
      displayOrder: 1,
    }).returning();
    await db.insert(inventoryBalancesTable).values({
      tenantId: tenant.id,
      productId: item.id,
      locationId: location.id,
      quantityOnHand: "10",
      parLevel: "2",
    });
    await db.insert(inventoryTemplatesTable).values({
      tenantId: tenant.id,
      sectionName: "E2E Inventory",
      itemName: "E2E Customer Item",
      rowType: "item",
      unitType: "#",
      startingQuantityDefault: "10",
      displayOrder: 1,
      catalogItemId: item.id,
      alavontId: "E2E-ALV-1",
      currentStock: "10",
      parLevel: "2",
    });

    server = app.listen(0);
    request = supertest(server);
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  });

  it("processes customer provisioning through supervisor shift close", async () => {
    const login = await as("customer").get("/api/users/me");
    expect(login.status, login.text).toBe(200);
    expect(login.body).toMatchObject({ email: identities.customer.email, role: "user", status: "approved" });

    const template = await as("csr").get("/api/shifts/inventory-template");
    expect(template.status, template.text).toBe(200);
    const templateRow = template.body.template.find((row: { catalogItemId?: number }) => row.catalogItemId === catalogItemId);
    expect(templateRow).toBeTruthy();

    const clockIn = await as("csr").post("/api/shifts/clock-in").send({
      boxAssignmentId: "sales-box-1",
      cashBankStart: 100,
      inventorySnapshot: [{ templateItemId: templateRow.id, quantityStart: 10 }],
      setup: {
        wifiReady: true,
        printerReady: true,
        locationReady: true,
        inventoryConfirmed: true,
        parLevelsConfirmed: true,
        shiftLocationId: "sales-box-1",
        deliveryOptionId: "pickup",
      },
    });
    expect(clockIn.status, clockIn.text).toBe(201);
    const shiftId = Number(clockIn.body.shift.id);
    expect(shiftId).toBeGreaterThan(0);

    const disclaimer = await as("customer").get("/api/customer/disclaimer");
    expect(disclaimer.status, disclaimer.text).toBe(200);
    expect(disclaimer.body).toMatchObject({ version: 1, accepted: false, required: true });
    const accepted = await as("customer").post("/api/customer/disclaimer/accept").send({ version: 1 });
    expect(accepted.status, accepted.text).toBe(201);

    const catalog = await as("customer").get("/api/catalog?search=E2E%20Customer%20Item");
    expect(catalog.status, catalog.text).toBe(200);
    expect(catalog.body.items.some((row: { id: number }) => row.id === catalogItemId)).toBe(true);

    const confirmation = {
      acceptedAllSalesFinal: true,
      confirmedAt: new Date().toISOString(),
      legalDisclaimerText: disclaimer.body.text,
    };
    const converted = await as("customer").post("/api/cart/convert").send({
      items: [{ catalogItemId, quantity: 1 }],
      confirmation,
    });
    expect(converted.status, converted.text).toBe(200);
    expect(converted.body.converted.items[0].customerSafeName).toBe("Merchant E2E Item");

    const orderCreated = await as("customer").post("/api/orders").send({
      orderType: "WALK_IN",
      items: [{ catalogItemId, quantity: 1 }],
      checkoutConversionToken: converted.body.checkoutConversionToken,
      checkoutConversionSnapshot: converted.body,
      checkoutConfirmation: { ...confirmation, paymentMethod: "cash" },
      deliveryMethod: "pickup",
      notes: "Opening-manager E2E order",
    });
    expect(orderCreated.status, orderCreated.text).toBe(201);
    const orderId = Number(orderCreated.body.id);
    expect(orderCreated.body).toMatchObject({ assignedCsrUserId: expect.any(Number) });

    const customerReceipt = await db.execute(sql`
      SELECT rendered_text
      FROM print_jobs
      WHERE order_id = ${orderId} AND job_output = 'customer_receipt' AND rendered_text IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `);
    expect(customerReceipt.rows[0]?.rendered_text).toContain("Merchant E2E Item");

    const queue = await as("csr").get("/api/shift-queue/orders");
    expect(queue.status, queue.text).toBe(200);
    expect(queue.body.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: orderId, assignedShiftId: shiftId }),
    ]));

    const claimed = await as("csr").post(`/api/orders/${orderId}/claim`).send({});
    expect(claimed.status, claimed.text).toBe(200);
    const preparing = await as("csr").post(`/api/orders/${orderId}/prepare`).send({});
    expect(preparing.status, preparing.text).toBe(200);
    expect(preparing.body.fulfillmentStatus).toBe("preparing");
    const ready = await as("csr").post(`/api/orders/${orderId}/ready`).send({});
    expect(ready.status, ready.text).toBe(200);
    expect(ready.body.fulfillmentStatus).toBe("ready");

    const closeout = await as("csr").post(`/api/orders/${orderId}/closeout`).send({
      paymentMethod: "cash",
      idempotencyKey: `pos-e2e-closeout-${orderId}`,
    });
    expect(closeout.status, closeout.text).toBe(200);
    expect(closeout.body.paymentStatus).toBe("paid");
    const completed = await as("csr").post(`/api/orders/${orderId}/fulfillment`).send({ fulfillmentStatus: "completed" });
    expect(completed.status, completed.text).toBe(200);
    expect(completed.body.fulfillmentStatus).toBe("completed");

    const current = await as("csr").get("/api/shifts/current");
    expect(current.status, current.text).toBe(200);
    const endingInventory = current.body.shift.inventory
      .filter((row: { rowType: string }) => row.rowType === "item")
      .map((row: { id: number; quantityStart: number; quantitySold: number }) => ({
        shiftInventoryItemId: row.id,
        quantityEndActual: Number(row.quantityStart) - Number(row.quantitySold),
      }));
    const shiftClose = await as("csr").post("/api/shifts/clock-out").send({
      endingInventory,
      cashBankEnd: 121.60,
    });
    expect(shiftClose.status, shiftClose.text).toBe(200);
    expect(shiftClose.body.shift.status).toBe("supervisor_pending");
    expect(shiftClose.body.summary).toMatchObject({ orderCount: 1, cashSales: 21.6 });
    expect(shiftClose.body.summary.inventorySummary[0]).toMatchObject({ quantityStart: 10, quantitySold: 1, quantityEndActual: 9 });

    const shiftReceipt = await db.execute(sql`
      SELECT rendered_text
      FROM print_jobs
      WHERE job_output = 'shift_end_receipt' AND rendered_text IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `);
    expect(shiftReceipt.rows[0]?.rendered_text).toContain("SHIFT END");

    const finalized = await as("admin").post(`/api/shifts/${shiftId}/supervisor-checkout`).send({ tipPercent: 15 });
    expect(finalized.status, finalized.text).toBe(200);
    expect(finalized.body.shift.status).toBe("finalized");
    expect(finalized.body.checkout).toMatchObject({ eligibleSalesBase: 21.6, tipPercent: 15 });

    const persisted = await db.execute(sql`
      SELECT o.status, o.payment_status, s.status AS shift_status,
             ib.quantity_on_hand, COUNT(cle.id)::int AS cash_ledger_entries
      FROM orders o
      JOIN lab_tech_shifts s ON s.id = o.assigned_shift_id
      JOIN inventory_balances ib ON ib.product_id = ${catalogItemId}
      LEFT JOIN cash_ledger_entries cle ON cle.order_id = o.id
      WHERE o.id = ${orderId}
      GROUP BY o.status, o.payment_status, s.status, ib.quantity_on_hand
    `);
    expect(persisted.rows[0]).toMatchObject({
      status: "completed",
      payment_status: "paid",
      shift_status: "finalized",
      quantity_on_hand: "9.000",
      cash_ledger_entries: 1,
    });
  }, 60_000);
});
