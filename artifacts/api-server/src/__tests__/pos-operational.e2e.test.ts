import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { sql } from "drizzle-orm";

const identities = vi.hoisted(() => ({
  customer: { clerkId: "e2e_customer", email: "customer@pos-e2e.test", role: "user" },
  csr: { clerkId: "e2e_csr", email: "csr@pos-e2e.test", role: "csr" },
  csr2: { clerkId: "e2e_csr2", email: "csr2@pos-e2e.test", role: "csr" },
  supervisor: { clerkId: "e2e_supervisor", email: "supervisor@pos-e2e.test", role: "supervisor" },
  admin: { clerkId: "e2e_admin", email: "admin@pos-e2e.test", role: "admin" },
  outsider: { clerkId: "e2e_outsider", email: "outsider@pos-e2e.test", role: "admin" },
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
        firstName: key === "customer" ? "Pat" : key === "csr" ? "Casey" : key === "csr2" ? "Jordan" : key === "supervisor" ? "Sam" : "Alex",
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
  labTechShiftsTable,
  generalQueueCashSessionsTable,
  cashLedgerEntriesTable,
  auditLogsTable,
  ordersTable,
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
        clerkId: identities.csr2.clerkId,
        email: identities.csr2.email,
        normalizedEmail: identities.csr2.email,
        firstName: "Jordan",
        lastName: "E2E",
        role: "csr",
        tenantId: tenant.id,
        status: "approved",
        identityStatus: "verified",
        provisioningStatus: "active",
      },
      {
        clerkId: identities.supervisor.clerkId,
        email: identities.supervisor.email,
        normalizedEmail: identities.supervisor.email,
        firstName: "Sam",
        lastName: "E2E",
        role: "supervisor",
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
    const [otherTenant] = await db.insert(tenantsTable).values({ name: "Other E2E Tenant", slug: "other-e2e-tenant", status: "active" }).returning();
    await db.insert(usersTable).values({
      clerkId: identities.outsider.clerkId,
      email: identities.outsider.email,
      normalizedEmail: identities.outsider.email,
      firstName: "Other",
      lastName: "Tenant",
      role: "admin",
      tenantId: otherTenant.id,
      status: "approved",
      identityStatus: "verified",
      provisioningStatus: "active",
    });

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
    const csrSettings = await as("supervisor").get("/api/admin/csr-settings");
    expect(csrSettings.status, csrSettings.text).toBe(200);
    expect(csrSettings.body).toMatchObject({
      pickupInstructionOptions: expect.any(Array),
      shiftLocationOptions: expect.any(Array),
      deliveryOptions: expect.any(Array),
    });
    for (const inventoryPath of [
      "/api/admin/inventory-template",
      "/api/admin/csr-boxes",
      "/api/admin/inventory-locations",
      "/api/admin/inventory-balances",
      "/api/admin/inventory",
      "/api/admin/inventory/orphans",
      "/api/admin/inventory/health",
    ]) {
      const inventoryResponse = await as("csr").get(inventoryPath);
      expect(inventoryResponse.status, `${inventoryPath}: ${inventoryResponse.text}`).toBe(200);
    }
    const tenantUsers = await as("supervisor").get("/api/users");
    expect(tenantUsers.status, tenantUsers.text).toBe(200);
    expect(tenantUsers.body.users.every((candidate: { tenantId?: number }) => candidate.tenantId === tenantUsers.body.users[0]?.tenantId)).toBe(true);

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
    const activeQueueStatus = await as("admin").get("/api/shift-queue/status");
    expect(activeQueueStatus.status, activeQueueStatus.text).toBe(200);
    expect(activeQueueStatus.body.activeCsr).toMatchObject({ email: identities.csr.email });
    const activeCsrOptions = await as("admin").get("/api/orders/active-csrs");
    expect(activeCsrOptions.status, activeCsrOptions.text).toBe(200);
    expect(activeCsrOptions.body.csrs).toEqual([
      expect.objectContaining({ userId: expect.any(Number), shiftId, name: expect.stringContaining("Casey") }),
    ]);
    const outsiderCsrOptions = await as("outsider").get("/api/orders/active-csrs");
    expect(outsiderCsrOptions.status, outsiderCsrOptions.text).toBe(200);
    expect(outsiderCsrOptions.body.csrs).toEqual([]);

    const disclaimer = await as("customer").get("/api/customer/disclaimer");
    expect(disclaimer.status, disclaimer.text).toBe(200);
    expect(disclaimer.body).toMatchObject({ version: 1, accepted: false, required: true });
    const accepted = await as("customer").post("/api/customer/disclaimer/accept").send({ version: 1 });
    expect(accepted.status, accepted.text).toBe(201);

    const catalog = await as("customer").get("/api/catalog?search=E2E%20Customer%20Item");
    expect(catalog.status, catalog.text).toBe(200);
    expect(catalog.body.items.some((row: { id: number }) => row.id === catalogItemId)).toBe(true);
    const zappySearch = await as("customer").post("/api/ai/catalog-search").send({ query: "E2E Customer Item", limit: 5 });
    expect(zappySearch.status, zappySearch.text).toBe(200);
    expect(zappySearch.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: catalogItemId }),
    ]));
    const zappyConversation = await as("customer").post("/api/ai/chat").send({
      messages: [{ role: "user", content: "What do you recommend?" }],
      cart: [],
    });
    expect(zappyConversation.status, zappyConversation.text).toBe(200);
    expect(zappyConversation.body).toMatchObject({
      reply: expect.any(String),
      suggestedItems: expect.arrayContaining([expect.objectContaining({ id: catalogItemId })]),
      conversationId: expect.stringMatching(/^conv_/),
    });
    const printerSettings = await as("admin").get("/api/admin/printers/settings");
    expect(printerSettings.status, printerSettings.text).toBe(200);

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
      amountTendered: "25.00",
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
    const [shiftLedger] = await db.select().from(cashLedgerEntriesTable).where(sql`${cashLedgerEntriesTable.orderId} = ${orderId}`);
    expect(shiftLedger).toMatchObject({ shiftId, generalQueueSessionId: null, actorUserId: expect.any(Number) });
  }, 60_000);

  it("claims General Queue orders through the authenticated application-user shift relationship", async () => {
    const [tenant] = await db.select().from(tenantsTable).where(sql`${tenantsTable.slug} = 'pos-e2e-house'`).limit(1);
    const [admin] = await db.select().from(usersTable).where(sql`${usersTable.clerkId} = ${identities.admin.clerkId}`).limit(1);
    const [csr2] = await db.select().from(usersTable).where(sql`${usersTable.clerkId} = ${identities.csr2.clerkId}`).limit(1);
    const [customer] = await db.select().from(usersTable).where(sql`${usersTable.clerkId} = ${identities.customer.clerkId}`).limit(1);
    const [box] = await db.select().from(csrBoxesTable).where(sql`${csrBoxesTable.tenantId} = ${tenant.id}`).limit(1);
    const setupJson = { boxAssignmentId: box.slug, inventoryConfirmed: true, startingInventoryConfirmed: true, parLevelsConfirmed: true, printerReady: true, printerAssigned: true };
    const [adminShift, csr2Shift] = await db.insert(labTechShiftsTable).values([
      { tenantId: tenant.id, techId: admin.id, status: "active", boxAssignmentId: box.slug, setupJson },
      { tenantId: tenant.id, techId: csr2.id, status: "active", boxAssignmentId: box.slug, setupJson },
    ]).returning();
    const [order] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: admin.id, status: "submitted", fulfillmentStatus: "submitted",
      paymentStatus: "unpaid", subtotal: "10.00", tax: "0.80", total: "10.80",
      routeSource: "general_account", routedTo: "default_queue", routingStatus: "queued",
    }).returning();

    const eligible = await as("supervisor").get("/api/orders/active-csrs");
    expect(eligible.status, eligible.text).toBe(200);
    expect(eligible.body.csrs).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: admin.id, shiftId: adminShift.id, label: expect.stringContaining("CSR Sales Box 1") }),
      expect.objectContaining({ userId: csr2.id, shiftId: csr2Shift.id }),
    ]));

    const claimed = await as("admin").post(`/api/orders/${order.id}/claim`).send({});
    expect(claimed.status, claimed.text).toBe(200);
    expect(claimed.body).toMatchObject({
      id: order.id,
      assignedCsrUserId: admin.id,
      status: "in_progress",
      fulfillmentStatus: "in_progress",
      routeSource: "active_csr",
    });
    const [persistedClaim] = await db.select().from(ordersTable).where(sql`${ordersTable.id} = ${order.id}`).limit(1);
    expect(persistedClaim).toMatchObject({ assignedCsrUserId: admin.id, assignedShiftId: adminShift.id });
    expect((await as("admin").post(`/api/orders/${order.id}/claim`).send({})).status).toBe(200);
    expect((await as("csr2").post(`/api/orders/${order.id}/claim`).send({})).status).toBe(409);
    expect((await as("csr2").post(`/api/orders/${order.id}/reassign`).send({ assignedCsrUserId: csr2.id })).status).toBe(403);

    const general = await as("admin").get("/api/shift-queue/general");
    expect(general.body.orders).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id })]));
    const assigned = await as("admin").get("/api/shift-queue/orders");
    expect(assigned.body.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: order.id, assignedCsrUserId: admin.id, assignedShiftId: adminShift.id }),
    ]));

    const [terminal] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: customer.id, status: "completed", fulfillmentStatus: "completed",
      paymentStatus: "paid", subtotal: "1.00", tax: "0.08", total: "1.08",
      routeSource: "general_account", routedTo: "default_queue",
    }).returning();
    expect((await as("admin").post(`/api/orders/${terminal.id}/claim`).send({})).status).toBe(409);
    expect((await as("supervisor").post(`/api/orders/${terminal.id}/reassign`).send({ assignedCsrUserId: csr2.id })).status).toBe(400);

    const [raceOrder] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: customer.id, status: "submitted", fulfillmentStatus: "submitted",
      paymentStatus: "unpaid", subtotal: "2.00", tax: "0.16", total: "2.16",
      routeSource: "general_account", routedTo: "default_queue",
    }).returning();
    const race = await Promise.all([
      as("admin").post(`/api/orders/${raceOrder.id}/claim`).send({}),
      as("csr2").post(`/api/orders/${raceOrder.id}/claim`).send({}),
    ]);
    expect(race.filter(response => response.status === 200)).toHaveLength(1);
    expect(race.filter(response => response.status === 409)).toHaveLength(1);

    await db.execute(sql`UPDATE lab_tech_shifts SET status = 'clocked_out', clocked_out_at = now() WHERE id IN (${adminShift.id}, ${csr2Shift.id})`);
  }, 60_000);

  it("manages a tenant-isolated General Queue cash session with atomic claims and closeout", async () => {
    const [tenant] = await db.select().from(tenantsTable).where(sql`${tenantsTable.slug} = 'pos-e2e-house'`).limit(1);
    const [customer] = await db.select().from(usersTable).where(sql`${usersTable.email} = ${identities.customer.email}`).limit(1);
    const [csr] = await db.select().from(usersTable).where(sql`${usersTable.email} = ${identities.csr.email}`).limit(1);
    const [box] = await db.select().from(csrBoxesTable).where(sql`${csrBoxesTable.tenantId} = ${tenant.id}`).limit(1);
    const [location] = await db.select().from(inventoryLocationsTable).where(sql`${inventoryLocationsTable.csrBoxId} = ${box.id}`).limit(1);
    const [order] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: customer.id, status: "submitted", fulfillmentStatus: "submitted",
      paymentStatus: "unpaid", subtotal: "20.00", tax: "1.60", total: "21.60",
      routeSource: "general_account", routedTo: "default_queue", routingStatus: "queued",
    }).returning();

    const status = await as("admin").get("/api/shift-queue/status");
    expect(status.status, status.text).toBe(200);
    expect(status.body).toMatchObject({ message: "General Queue Active", activeCsr: null });

    const tenantQueue = await as("admin").get("/api/shift-queue/general");
    expect(tenantQueue.status, tenantQueue.text).toBe(200);
    expect(tenantQueue.body.orders).toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id })]));
    const outsiderQueue = await as("outsider").get("/api/shift-queue/general");
    expect(outsiderQueue.status, outsiderQueue.text).toBe(200);
    expect(outsiderQueue.body.orders).toEqual([]);
    expect((await as("outsider").post(`/api/orders/${order.id}/claim`).send({})).status).not.toBe(200);
    expect((await as("outsider").post(`/api/orders/${order.id}/assign`).send({ assigneeUserId: 4, reason: "Cross tenant attempt" })).status).not.toBe(200);
    expect((await as("outsider").post(`/api/orders/${order.id}/closeout`).send({ paymentMethod: "cash", amountTendered: "25.00", idempotencyKey: `outsider-${order.id}`, supervisorOverride: true })).status).toBe(404);

    // General Queue cash-session accounting is deliberately independent from
    // Claim: Claim now requires and records an eligible active shift. Seed the
    // accountable session participant here so this test remains focused on
    // migration 0038's no-shift cash path.
    const winner = "csr" as const;
    const loser = "csr2" as const;
    await db.update(ordersTable).set({
      assignedCsrUserId: csr.id,
      assignedShiftId: null,
      acceptedAt: new Date(),
      status: "in_progress",
      fulfillmentStatus: "in_progress",
    }).where(sql`${ordersTable.id} = ${order.id}`);

    const sessionOptions = await as("admin").get("/api/shift-queue/general/session/options");
    expect(sessionOptions.status, sessionOptions.text).toBe(200);
    expect(sessionOptions.body.options).toEqual([
      expect.objectContaining({ registerBoxId: box.id, locationId: location.id, registerLabel: box.label, locationName: location.name }),
    ]);
    const outsiderSessionOptions = await as("outsider").get("/api/shift-queue/general/session/options");
    expect(outsiderSessionOptions.status, outsiderSessionOptions.text).toBe(200);
    expect(outsiderSessionOptions.body.options).toEqual([]);

    const [opened, duplicateOpen] = await Promise.all([
      as("admin").post("/api/shift-queue/general/session/open").send({ registerBoxId: box.id, locationId: location.id, openingBalance: 100 }),
      as("admin").post("/api/shift-queue/general/session/open").send({ registerBoxId: box.id, locationId: location.id, openingBalance: 100 }),
    ]);
    expect(opened.status, opened.text).toBe(201);
    const sessionId = opened.body.session.id;
    expect(duplicateOpen.status, duplicateOpen.text).toBe(201);
    expect(duplicateOpen.body.session.id).toBe(sessionId);
    expect((await as("outsider").post(`/api/shift-queue/general/session/${sessionId}/join`).send({})).status).toBe(404);
    expect((await as("outsider").post("/api/shift-queue/general/session/open").send({ registerBoxId: box.id, locationId: location.id, openingBalance: 0 })).status).toBe(422);

    const joined = await as(winner).post(`/api/shift-queue/general/session/${sessionId}/join`).send({});
    expect(joined.status, joined.text).toBe(200);
    const forbidden = await as(loser).post(`/api/orders/${order.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: "25.00", idempotencyKey: `gq-loser-${order.id}`,
    });
    expect(forbidden.status, forbidden.text).toBe(403);

    const insufficient = await as(winner).post(`/api/orders/${order.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: "20.00", idempotencyKey: `gq-low-${order.id}`,
    });
    expect(insufficient.status, insufficient.text).toBe(422);
    expect(insufficient.body.error).toContain("insufficient");
    const tampered = await as(winner).post(`/api/orders/${order.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: "25.00", total: "0.01", idempotencyKey: `gq-tamper-${order.id}`,
    });
    expect(tampered.status, tampered.text).toBe(422);

    for (const terminalStatus of ["paid", "cancelled", "refunded", "voided", "completed", "archived"]) {
      const [terminalOrder] = await db.insert(ordersTable).values({
        tenantId: tenant.id, customerId: customer.id,
        status: terminalStatus === "paid" ? "in_progress" : terminalStatus,
        fulfillmentStatus: terminalStatus === "paid" ? "in_progress" : terminalStatus,
        paymentStatus: terminalStatus === "paid" ? "paid" : "unpaid",
        subtotal: "1.00", tax: "0.08", total: "1.08",
        routeSource: "general_account", routedTo: "default_queue", assignedCsrUserId: csr.id, acceptedAt: new Date(),
      }).returning();
      const rejected = await as("admin").post(`/api/orders/${terminalOrder.id}/closeout`).send({
        paymentMethod: "cash", amountTendered: "2.00", idempotencyKey: `terminal-${terminalStatus}-${terminalOrder.id}`, supervisorOverride: true,
      });
      expect(rejected.status, `${terminalStatus}: ${rejected.text}`).toBe(409);
    }

    const key = `gq-closeout-${order.id}`;
    const [closed, concurrent] = await Promise.all([
      as(winner).post(`/api/orders/${order.id}/closeout`).send({ paymentMethod: "cash", amountTendered: "25.00", internalNote: "E2E cash", idempotencyKey: key }),
      as(winner).post(`/api/orders/${order.id}/closeout`).send({ paymentMethod: "cash", amountTendered: "25.00", internalNote: "E2E cash", idempotencyKey: key }),
    ]);
    expect([closed.status, concurrent.status]).toEqual([200, 200]);
    expect(closed.body.cash ?? concurrent.body.cash).toMatchObject({ amountDue: "21.60", amountTendered: "25.00", changeGiven: "3.40" });
    const unrelatedReplay = await as(loser).post(`/api/orders/${order.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: "25.00", idempotencyKey: key,
    });
    expect(unrelatedReplay.status, unrelatedReplay.text).toBe(403);

    const entries = await db.select().from(cashLedgerEntriesTable).where(sql`${cashLedgerEntriesTable.orderId} = ${order.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tenantId: tenant.id, orderId: order.id, actorUserId: expect.any(Number), generalQueueSessionId: sessionId, locationId: location.id, boxAssignmentId: box.slug, amount: "21.60", amountTendered: "25.00", changeGiven: "3.40" });
    const audits = await db.select().from(auditLogsTable).where(sql`${auditLogsTable.resourceId} = ${String(order.id)}`);
    expect(audits.some(row => row.action === "CASH_CLOSEOUT_COMPLETED")).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/token|cookie|secret/i);

    const session = await db.select().from(generalQueueCashSessionsTable).where(sql`${generalQueueCashSessionsTable.id} = ${sessionId}`);
    expect(session[0].paymentTotalsJson).toMatchObject({ cash: 21.6 });

    const [overrideOrder] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: customer.id, status: "in_progress", fulfillmentStatus: "in_progress",
      paymentStatus: "unpaid", subtotal: "5.00", tax: "0.40", total: "5.40",
      routeSource: "general_account", routedTo: "default_queue", assignedCsrUserId: csr.id, acceptedAt: new Date(),
    }).returning();
    const overridden = await as("admin").post(`/api/orders/${overrideOrder.id}/closeout`).send({
      paymentMethod: "cash", amountTendered: "6.00", idempotencyKey: `gq-override-${overrideOrder.id}`, supervisorOverride: true,
    });
    expect(overridden.status, overridden.text).toBe(200);
    const overrideAudits = await db.select().from(auditLogsTable).where(sql`${auditLogsTable.resourceId} = ${String(overrideOrder.id)}`);
    expect(overrideAudits.some(row => row.action === "CASH_CLOSEOUT_SUPERVISOR_OVERRIDE")).toBe(true);

    const reconciled = await as("admin").post(`/api/shift-queue/general/session/${sessionId}/close`).send({ closingBalance: 127 });
    expect(reconciled.status, reconciled.text).toBe(200);
    expect(reconciled.body.session).toMatchObject({ expectedBalance: "127.00", differenceAmount: "0.00" });

    const [nextOrder] = await db.insert(ordersTable).values({
      tenantId: tenant.id, customerId: customer.id, status: "in_progress", fulfillmentStatus: "in_progress",
      paymentStatus: "unpaid", subtotal: "10.00", tax: "0.80", total: "10.80",
      routeSource: "general_account", routedTo: "default_queue", assignedCsrUserId: csr.id, acceptedAt: new Date(),
    }).returning();
    const blockedAfterClose = await as("csr").post(`/api/orders/${nextOrder.id}/closeout`).send({ paymentMethod: "cash", amountTendered: "11.00", idempotencyKey: `closed-session-${nextOrder.id}` });
    expect(blockedAfterClose.status, blockedAfterClose.text).toBe(409);
    expect(blockedAfterClose.body.error).toBe("A General Queue cash session must be opened before accepting cash.");
  }, 60_000);
});
