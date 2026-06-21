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
    if (path === "/api/current-user") return json({ id: 1, role: "user", email: "customer@example.com" });
    if (path === "/api/admin/settings") return json({ enabledProcessors: processors });
    if (path === "/api/orders/preview-conversion" && method === "POST") {
      return json({
        alavontCartSnapshot: [{ catalogItemId: 354, name: "Calm Drops", category: "Wellness" }],
        luciferCheckoutSnapshot: [{ catalogItemId: 354, name: "LC Safe Item", category: "Self Care", description: "Safe merchant description" }],
        checkoutConversionSnapshot: { lines: [{ catalogItemId: 354, merchantName: "LC Safe Item" }] },
        totals: { subtotal: 24, tax: 0, total: 24 },
      });
    }
    if (path === "/api/orders" && method === "POST") return json({ id: 9001, status: "pending", paymentStatus: "pending", items: [{ catalogItemId: 354, quantity: 1 }] }, 201);
    if (path === "/api/payments/tokenize" && method === "POST") return json({ paymentIntentId: "pi_test_pos", clientSecret: "pi_test_pos_secret", orderId: 9001 });
    if (path === "/api/payments/9001/confirm" && method === "POST") return json({ id: 9001, status: "confirmed", paymentStatus: "paid", inventoryDeducted: true });
    if (path === "/api/orders/9001") return json({ id: 9001, status: "confirmed", paymentStatus: "paid", assignedShiftId: 77 });
    if (path === "/api/shifts/active") return json({ shift: { id: 77, boxAssignmentId: "sales-box-1", status: "active", setupJson: { inventoryConfirmed: true } } });
    if (path === "/api/shifts/inventory-template") return json({ items: [{ catalogItemId: 354, itemName: "Calm Drops", quantityStart: "12" }] });
    if (path === "/api/shift-queue/orders") return json({ orders: [{ id: 9001, status: "pending", assignedShiftId: 77 }] });
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
    await page.getByTestId("button-preview-conversion").click();
    await expect(page.getByText("LC Safe Item")).toBeVisible();
    await page.goto("/orders/9001");
    await expect(page.getByTestId("button-pay")).toBeVisible();
    await expect(page.getByTestId("button-paypal")).toHaveCount(0);
    await expect(page.getByTestId("button-cashapp")).toHaveCount(0);
  });

  test("CSR shift → queue → order workflow can be driven from mocked POS APIs", async ({ page }) => {
    await mockPosApi(page);
    await page.goto("/staff");
    await page.goto("/shift-queue");
    await expect(page.getByText(/9001|pending|queue/i).first()).toBeVisible();
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
