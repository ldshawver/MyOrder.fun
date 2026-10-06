import { expect, test } from "@playwright/test";
import pg from "../../../node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";

const enabled = process.env.RUN_LOCATIONS_PLAYWRIGHT === "1";
test.skip(!enabled, "Set RUN_LOCATIONS_PLAYWRIGHT=1 for disposable Locations acceptance.");

const fixture = `pw_loc_${Date.now()}`;
let client: pg.Client;
let backstockId = 0;
let csrId = 0;

test.beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://phase1_acceptance:phase1_local_only@127.0.0.1:55436/phase1_acceptance", ssl: false });
  await client.connect();
});

test.afterAll(async () => {
  if (!client) return;
  await client.query("DELETE FROM inventory_locations WHERE tenant_id=1 AND id IN ($1,$2)", [backstockId, csrId]);
  await client.end();
});

test("canonical Locations manages backstock and CSR-box locations", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/admin/inventory", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Locations" }).click();
  await expect(page.getByText("Locations are the physical storage areas", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add Location" }).click();
  const create = page.getByText("New Location").locator("..").locator("..");
  await create.getByPlaceholder("e.g. Overflow Backstock").fill(`${fixture} Backstock`);
  await create.locator("select").selectOption("backstock");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`${fixture} Backstock`, { exact: true })).toBeVisible();
  backstockId = Number((await client.query("SELECT id FROM inventory_locations WHERE tenant_id=1 AND name=$1", [`${fixture} Backstock`])).rows[0].id);

  await page.getByRole("button", { name: "Add Location" }).click();
  const csrForm = page.getByText("New Location").locator("..").locator("..");
  await csrForm.getByPlaceholder("e.g. Overflow Backstock").fill(`${fixture} CSR Box`);
  await csrForm.locator("select").selectOption("csr_box");
  await csrForm.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`${fixture} CSR Box`, { exact: true })).toBeVisible();
  csrId = Number((await client.query("SELECT id FROM inventory_locations WHERE tenant_id=1 AND name=$1", [`${fixture} CSR Box`])).rows[0].id);
  expect((await client.query("SELECT count(*)::int AS count FROM csr_boxes WHERE tenant_id=1 AND slug=$1", [fixture])).rows[0].count).toBe(0);

  const csrRow = page.getByTestId(`location-row-${csrId}`);
  await csrRow.getByRole("button", { name: "Edit" }).click();
  await csrRow.getByRole("textbox").fill(`${fixture} CSR Box Updated`);
  await csrRow.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`${fixture} CSR Box Updated`, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Locations" }).click();
  await expect(page.getByText(`${fixture} CSR Box Updated`, { exact: true })).toBeVisible();
  expect((await client.query("SELECT name,type,is_active FROM inventory_locations WHERE id=$1", [csrId])).rows[0]).toMatchObject({ name: `${fixture} CSR Box Updated`, type: "csr_box", is_active: true });
  expect(errors).toEqual([]);
});
