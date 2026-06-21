import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "https://myorder.fun";

type Role = "admin" | "csr" | "supervisor" | "customer";

const credentials: Record<Role, { email: string; password: string; statePath: string }> = {
  admin: {
    email: process.env.MYORDER_ADMIN_EMAIL ?? "",
    password: process.env.MYORDER_ADMIN_PASSWORD ?? "",
    statePath: "playwright/.auth/admin.json",
  },
  csr: {
    email: process.env.MYORDER_CSR_EMAIL ?? "",
    password: process.env.MYORDER_CSR_PASSWORD ?? "",
    statePath: "playwright/.auth/csr.json",
  },
  supervisor: {
    email: process.env.MYORDER_SUPERVISOR_EMAIL ?? process.env.MYORDER_ADMIN_EMAIL ?? "",
    password: process.env.MYORDER_SUPERVISOR_PASSWORD ?? process.env.MYORDER_ADMIN_PASSWORD ?? "",
    statePath: "playwright/.auth/supervisor.json",
  },
  customer: {
    email: process.env.MYORDER_CUSTOMER_EMAIL ?? "",
    password: process.env.MYORDER_CUSTOMER_PASSWORD ?? "",
    statePath: "playwright/.auth/customer.json",
  },
};

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return;
    }
  }
  throw new Error(`No visible input found for ${selectors.join(", ")}`);
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return;
    }
  }
  throw new Error(`No visible button/link found for ${selectors.join(", ")}`);
}

async function clerkLogin(page: Page, role: Role) {
  const { email, password, statePath } = credentials[role];
  expect(email, `${role} email env var is required`).toBeTruthy();
  expect(password, `${role} password env var is required`).toBeTruthy();

  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
  await fillFirstVisible(page, [
    'input[name="identifier"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
  ], email);
  await clickFirstVisible(page, [
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button[type="submit"]',
  ]);
  await fillFirstVisible(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ], password);
  await clickFirstVisible(page, [
    'button:has-text("Sign in")',
    'button:has-text("Continue")',
    'button[type="submit"]',
  ]);
  await page.waitForURL(url => !url.pathname.includes("login") && !url.pathname.includes("sign-in"), { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/sign in to continue/i);
  await page.context().storageState({ path: statePath });
}

test("authenticate Clerk sessions for admin, CSR, supervisor, and customer", async ({ browser }) => {
  for (const role of ["admin", "csr", "supervisor", "customer"] as Role[]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await clerkLogin(page, role);
    await context.close();
  }
});
