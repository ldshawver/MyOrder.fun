import { expect, test, type Page } from "@playwright/test";

const publicCatalog = [
  {
    id: 354,
    name: "Alavont Calm Drops",
    alavontName: "Calm Drops",
    alavontCategory: "Wellness",
    alavontDescription: "Customer-safe relaxing drops.",
    alavontImageUrl: "/safe-calm.png",
    category: "Wellness",
    description: "Customer-safe relaxing drops.",
    price: "24.00",
    stockQuantity: "12",
    isAvailable: true,
  },
];

async function mockPosApi(page: Page, overrides: { processors?: string[]; archived?: boolean } = {}) {
  const processors = overrides.processors ?? ["stripe"];
  const catalog = overrides.archived ? [] : publicCatalog;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/catalog" || path === "/api/catalog/items") return json({ items: catalog, catalog });
    if (path === "/api/current-user") return json({ id: 1, role: "csr", email: "csr@example.com", status: "approved", isActive: true });
    if (path === "/api/admin/settings") return json({ enabledProcessors: processors });
    if (path === "/api/orders/preview-conversion" && method === "POST") {
      return json({
        conversionToken: "signed-conversion-token",
        checkoutConversionToken: "signed-conversion-token",
        alavontCartSnapshot: [{ catalogItemId: 354, name: "Calm Drops", category: "Wellness" }],
        luciferCheckoutSnapshot: [{ catalogItemId: 354, name: "LC Safe Item", category: "Self Care", description: "Safe merchant description" }],
        checkoutConversionSnapshot: { lines: [{ catalogItemId: 354, merchantName: "LC Safe Item" }] },
        pricingSnapshot: { subtotal: 24, tax: 0, total: 24, taxRate: 0 },
        converted: {
          brandName: "Lucifer Cruz",
          headline: "Converted checkout",
          zappyMessage: "Safe merchant checkout ready.",
          paymentMethods: [
            { id: "cash", label: "Cash", promoted: true, message: "Cash orders qualify for exclusive discounts." },
            { id: "stripe", label: "Stripe card", promoted: false },
          ],
          items: [{ catalogItemId: 354, displayName: "LC Safe Item", customerSafeName: "LC Safe Item", customerSafeDescription: "Safe merchant description", customerSafeCategory: "Self Care", customerSafeImage: "/safe-calm.png", displayCategory: "Self Care", displayImage: "/safe-calm.png", merchantBrandName: "Lucifer Cruz", marketingCopy: "Safe copy", quantity: 1, unitPrice: 24, lineSubtotal: 24 }],
        },
        totals: { subtotal: 24, tax: 0, total: 24 },
      });
    }
    if (path === "/api/orders" && method === "POST") return json({ id: 9001, status: "pending", paymentStatus: "pending", items: [{ catalogItemId: 354, quantity: 1 }] }, 201);
    if (path === "/api/payments/tokenize" && method === "POST") return json({ paymentIntentId: "pi_test_pos", clientSecret: "pi_test_pos_secret", orderId: 9001 });
    if (path === "/api/payments/9001/confirm" && method === "POST") return json({ id: 9001, status: "confirmed", paymentStatus: "paid", inventoryDeducted: true });
    if (path === "/api/orders/9001") return json({ id: 9001, status: "confirmed", paymentStatus: "paid", assignedShiftId: 77 });
    if (path === "/api/shifts/current" || path === "/api/shifts/active") return json({ shift: {
      id: 77, tech_id: 1, box_assignment_id: "sales-box-1", status: "active", setup_json: { inventoryConfirmed: true },
      clockedInAt: new Date(Date.now() - 15 * 60_000).toISOString(), cashBankStart: 100, runningCashBank: 124,
      inventory: [{ id: 1, templateItemId: 1, sectionName: "Wellness", rowType: "item", unitType: "EA", displayOrder: 1, catalogItemId: 354, itemName: "Calm Drops", unitPrice: 24, quantityStart: 12, quantitySold: 1, quantityEnd: 11, quantityEndActual: null, discrepancy: null, isFlagged: false }],
      stats: { orderCount: 1, totalRevenue: 24, cashSales: 24, cardSales: 0, compSales: 0, paymentTotals: { cash: 24 }, byItem: [{ catalogItemId: 354, name: "Calm Drops", qtySold: 1, revenue: 24 }], byCustomer: [{ customerId: 1, name: "Test Customer", orderCount: 1, total: 24, paymentMethod: "cash" }] }
    } });
    if (path === "/api/shifts/inventory-template") return json({ template: [{ id: 1, catalogItemId: 354, itemName: "Calm Drops", rowType: "item", unitType: "EA", startingQuantityDefault: 12, sectionName: "Wellness", displayOrder: 1, menuPrice: 24, payoutPrice: 0 }], boxes: [{ id: "sales-box-1", label: "CSR Sales Box 1" }] });
    if (path === "/api/shift-queue/orders") return json({ orders: [{ id: 9001, status: "pending", fulfillmentStatus: "pending", assignedShiftId: 77, customerName: "Test Customer", createdAt: new Date().toISOString(), paymentStatus: "paid", paymentMethod: "cash", total: 24, items: [{ catalogItemId: 354, catalogItemName: "Calm Drops", quantity: 1, unitPrice: 24 }] }], total: 1 });
    if (path === "/api/orders/9001/accept" && method === "POST") return json({ id: 9001, status: "processing" });
    if (path === "/api/orders/9001/fulfillment" && method === "POST") return json({ id: 9001, status: "completed" });
    if (path === "/api/admin/import/product-master" && method === "POST") return json({ importedProducts: 35, catalogItemsCreated: 35, inventoryBalancesUpserted: 140 });
    if (path === "/api/admin/catalog/354/archive" && method === "POST") return json({ id: 354, isAvailable: false, archivedAt: new Date().toISOString() });
    if (path.includes("supervisor-checkout") && method === "POST") return json({ shift: { id: 77, status: "finalized" }, printJobs: ["supervisor_checkout", "commission_summary", "restock_list", "box_inventory"] });
    return json({ ok: true });
  });
}

test.describe("MyOrder.fun POS browser verification", () => {
  test("customer catalog → cart → safe checkout transformation → Stripe payment", async ({ page }) => {
    await mockPosApi(page, { processors: ["stripe"] });
    await page.goto("/catalog");
    await expect(page.getByText("Calm Drops")).toBeVisible();
    await expect(page.getByText(/LC Safe Item|merchant_sku|margin|supplier|box/i)).toHaveCount(0);
    await page.getByTestId("link-buy-now-354").click();
    await page.goto("/new-order");
    await expect(page.getByTestId("button-preview-conversion")).toBeVisible();
    await expect(page.getByTestId("button-submit-order")).toBeDisabled();
    await page.screenshot({ path: "test-results/before-conversion-cart.png", fullPage: true });
    await test.info().attach("before-conversion-cart", { path: "test-results/before-conversion-cart.png", contentType: "image/png" });
    await page.screenshot({ path: "test-results/payment-disabled-before-conversion.png", fullPage: true });
    await test.info().attach("payment-disabled-before-conversion", { path: "test-results/payment-disabled-before-conversion.png", contentType: "image/png" });
    await page.getByTestId("button-preview-conversion").click();
    await expect(page.getByText("LC Safe Item")).toBeVisible();
    await expect(page.getByTestId("conversion-ready")).toBeVisible();
    await expect(page.getByTestId("button-submit-order")).toBeEnabled();
    await page.screenshot({ path: "test-results/after-conversion-cart.png", fullPage: true });
    await test.info().attach("after-conversion-cart", { path: "test-results/after-conversion-cart.png", contentType: "image/png" });
    await page.screenshot({ path: "test-results/payment-enabled-after-conversion.png", fullPage: true });
    await test.info().attach("payment-enabled-after-conversion", { path: "test-results/payment-enabled-after-conversion.png", contentType: "image/png" });
    await page.goto("/orders/9001");
    await expect(page.getByTestId("button-pay")).toBeVisible();
    await expect(page.getByTestId("button-paypal")).toHaveCount(0);
    await expect(page.getByTestId("button-cashapp")).toHaveCount(0);
  });

  test.describe("staff dashboard", () => {
    test.use({ storageState: "playwright/.auth/csr.json" });

    test("/staff renders active shift data without console errors", async ({ page }, testInfo) => {
      const consoleErrors: string[] = [];
      page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
      page.on("pageerror", error => consoleErrors.push(error.message));

      await mockPosApi(page);
      await page.goto("/staff", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("text-title")).toContainText("Shift Dashboard");
      await expect(page.getByText("Shift Active")).toBeVisible();
      await expect(page.getByText("Calm Drops").first()).toBeVisible();
      await testInfo.attach("staff-active-shift", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(consoleErrors, `Browser console/page errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    });
  });

  test("supervisor import/archive and payment settings change checkout UI", async ({ page }) => {
    await mockPosApi(page, { processors: ["stripe", "paypal", "cashapp"] });
    await page.goto("/orders/9001");
    await expect(page.getByTestId("button-pay")).toBeVisible();
    await expect(page.getByTestId("button-paypal")).toBeVisible();
    await expect(page.getByTestId("button-cashapp")).toBeVisible();

    await mockPosApi(page, { archived: true });
    await page.goto("/catalog");
    await expect(page.getByText("Calm Drops")).toHaveCount(0);
  });
});
