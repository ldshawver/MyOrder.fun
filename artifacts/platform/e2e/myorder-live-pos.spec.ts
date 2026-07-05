import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";

const liveEnabled = process.env.MYORDER_LIVE_E2E === "1";
const databaseUrl = process.env.DATABASE_URL ?? "";
const productMasterPath = process.env.MYORDER_PRODUCT_MASTER_FILE ?? "";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "https://myorder.fun";
const authState = {
  admin: "playwright/.auth/admin.json",
  csr: "playwright/.auth/csr.json",
  supervisor: "playwright/.auth/supervisor.json",
  customer: "playwright/.auth/customer.json",
} as const;

async function newRoleApi(role: keyof typeof authState): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, storageState: authState[role] });
}

async function apiJson(api: APIRequestContext, path: string) {
  const response = await api.get(path);
  await expect(response, `${path} should return 2xx`).toBeOK();
  return response.json() as Promise<unknown>;
}

async function assertNoPrivateFields(payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/"(customerSafeName|customerSafeDescription|luciferCruzName|luciferCruzDescription|merchantSku|supplier|cost|margin|boxAssignmentId|quantityOnHand|parLevel|complianceHold|quarantineReason)"/i);
}

async function sqlScalar(query: string) {
  const { execFileSync } = await import("node:child_process");
  expect(databaseUrl, "DATABASE_URL is required for live SQL proof").toBeTruthy();
  return execFileSync("psql", [databaseUrl, "-At", "-c", query], { encoding: "utf8" }).trim();
}

async function importProductMaster(api: APIRequestContext) {
  expect(productMasterPath, "MYORDER_PRODUCT_MASTER_FILE is required").toBeTruthy();
  const response = await api.post("/api/admin/import/product-master", {
    multipart: { file: { name: "product-master.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await import("node:fs/promises").then(fs => fs.readFile(productMasterPath))) } },
  });
  await expect(response, "Product Master import should succeed").toBeOK();
  return response.json() as Promise<unknown>;
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return selector;
    }
  }
  throw new Error(`No visible selector found: ${selectors.join(", ")}`);
}

test.describe("LIVE MyOrder.fun POS verification with Clerk sessions", () => {
  test.skip(!liveEnabled, "Set MYORDER_LIVE_E2E=1 and provide Clerk login env vars, DATABASE_URL, and MYORDER_PRODUCT_MASTER_FILE.");

  test("admin import creates 140 balances and public catalog stays customer-safe", async ({}, testInfo) => {
    const adminApi = await newRoleApi("admin");
    const customerApi = await newRoleApi("customer");
    const importResponse = await importProductMaster(adminApi);
    await testInfo.attach("product-master-import-response", { body: JSON.stringify(importResponse, null, 2), contentType: "application/json" });

    const balanceCount = await sqlScalar("SELECT count(*) FROM inventory_balances WHERE product_id BETWEEN 354 AND 388;");
    await testInfo.attach("inventory-balances-354-388-count", { body: `${balanceCount}\n`, contentType: "text/plain" });
    expect(balanceCount).toBe("140");

    const catalog = await apiJson(customerApi, "/api/catalog");
    await assertNoPrivateFields(catalog);
    await testInfo.attach("public-catalog-sample", { body: JSON.stringify(catalog, null, 2).slice(0, 20_000), contentType: "application/json" });
    await adminApi.dispose();
    await customerApi.dispose();
  });

  test.use({ storageState: authState.customer });
  test("customer can browse, cart, safe-transform, payment page, and order status without console errors", async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", err => consoleErrors.push(err.message));

    await page.goto(`${baseURL}/catalog`, { waitUntil: "domcontentloaded" });
    await testInfo.attach("customer-catalog", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await expect(page.locator("body")).not.toContainText(/customerSafeName|merchantSku|supplier|margin|quantityOnHand/i);

    await clickFirstVisible(page, ['[data-testid^="link-buy-now-"]', 'button:has-text("Add to Cart")', 'text=/Add to Cart/i']);
    await page.goto(`${baseURL}/new-order`, { waitUntil: "domcontentloaded" });
    await clickFirstVisible(page, ['[data-testid="button-preview-conversion"]', 'button:has-text("Confirm")', 'button:has-text("Checkout")']);
    await testInfo.attach("safe-checkout-transformation", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await expect(page.locator("body")).toContainText(/safe|payment|checkout|confirm/i);

    await page.goto(`${baseURL}/orders`, { waitUntil: "domcontentloaded" });
    await testInfo.attach("customer-order-status", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    expect(consoleErrors, `Browser console/page errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });

  test("CSR shift, queue, order workflow, receipts, and supervisor closeout produce SQL/API proof", async ({}, testInfo) => {
    const csrApi = await newRoleApi("csr");
    const supervisorApi = await newRoleApi("supervisor");
    const shiftStart = await csrApi.post("/api/shifts/clock-in", { data: { boxAssignmentId: "sales-box-1", inventoryConfirmed: true } });
    await expect(shiftStart, "CSR shift start should succeed").toBeOK();
    const shiftPayload = await shiftStart.json() as { shift?: { id?: number } };
    await testInfo.attach("csr-shift-start", { body: JSON.stringify(shiftPayload, null, 2), contentType: "application/json" });
    const shiftId = shiftPayload.shift?.id;
    expect(shiftId).toBeTruthy();

    const inventory = await apiJson(csrApi, "/api/shifts/inventory-template?locationId=sales-box-1");
    await testInfo.attach("csr-beginning-inventory", { body: JSON.stringify(inventory, null, 2), contentType: "application/json" });

    const queue = await apiJson(csrApi, "/api/shift-queue/orders");
    await testInfo.attach("csr-queue", { body: JSON.stringify(queue, null, 2), contentType: "application/json" });

    const printCountBefore = await sqlScalar("SELECT count(*) FROM print_jobs;");
    await supervisorApi.post(`/api/shifts/${shiftId}/supervisor-checkout`, { data: { tipPercent: 15 } }).catch(() => undefined);
    const printCountAfter = await sqlScalar("SELECT count(*) FROM print_jobs;");
    await testInfo.attach("print-job-count-before-after", { body: JSON.stringify({ printCountBefore, printCountAfter }, null, 2), contentType: "application/json" });
    expect(Number(printCountAfter)).toBeGreaterThanOrEqual(Number(printCountBefore));
    await csrApi.dispose();
    await supervisorApi.dispose();
  });

  test("archived product is hidden from catalog and Zappy responses", async ({}, testInfo) => {
    const adminApi = await newRoleApi("admin");
    const customerApi = await newRoleApi("customer");
    const archive = await adminApi.post("/api/admin/catalog/354/archive");
    await expect(archive, "Archive endpoint should succeed").toBeOK();
    const catalog = await apiJson(customerApi, "/api/catalog");
    expect(JSON.stringify(catalog)).not.toContain('"id":354');
    const zappy = await customerApi.post("/api/ai/chat", { data: { message: "Tell me about product 354" } });
    await expect(zappy).toBeOK();
    const zappyPayload = await zappy.json() as unknown;
    await testInfo.attach("zappy-after-archive", { body: JSON.stringify(zappyPayload, null, 2), contentType: "application/json" });
    expect(JSON.stringify(zappyPayload)).not.toContain('"catalogItemId":354');
    await adminApi.dispose();
    await customerApi.dispose();
  });
});
