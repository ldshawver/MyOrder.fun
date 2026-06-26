import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");
const platformRoot = resolve(repoRoot, "artifacts/platform/src");
const apiRoot = resolve(repoRoot, "artifacts/api-server/src");

function src(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}
function platform(path: string): string {
  return readFileSync(resolve(platformRoot, path), "utf8");
}
function api(path: string): string {
  return readFileSync(resolve(apiRoot, path), "utf8");
}

describe("MyOrder.fun navigation and editor consolidation", () => {
  const layout = platform("components/layout.tsx");
  const app = platform("App.tsx");
  const routesIndex = api("routes/index.ts");

  it("removes unrelated LUXit/MyPayLink navigation and routes", () => {
    for (const forbidden of ["SMS & Calls", "Phone & SMS", "Document Hub", "Contractor Hub"]) {
      expect(layout).not.toContain(forbidden);
      expect(app).not.toContain(forbidden.replaceAll(" ", ""));
    }
    expect(layout).not.toContain("SMS & Calls");
    expect(layout).not.toContain("Contractor Hub");
    expect(layout).not.toContain("Document Hub");
    expect(app).not.toContain('path="/document-hub"');
    expect(app).not.toContain('path="/contractor-hub"');
    expect(app).not.toContain('path="/admin/communications"');
    expect(app).not.toContain('path="/communications"');
    expect(app).not.toContain("public-contract-sign");
    expect(app).not.toContain("contractor-hub");
    expect(app).not.toContain("document-hub");
    expect(routesIndex).not.toContain("contractor-hub");
    expect(routesIndex).not.toContain("document-hub");
    expect(routesIndex).not.toContain("proposalsRouter");
  });

  it("uses Settings and one Receipts & Printers nav entry", () => {
    expect(layout).toContain('label: "Settings"');
    const receiptLinks = layout.match(/label:\s*"Receipts & Printers"/g) ?? [];
    expect(receiptLinks.length).toBeGreaterThanOrEqual(1);
    expect(layout).not.toContain('label: "Receipt Templates"');
    expect(layout).not.toContain('label: "Reprint Receipts"');
    expect(layout).not.toContain('label: "WooCommerce"');
    expect(layout).not.toContain('label: "Integrations"');
  });

  it("replaces web-editor Plasmic UI copy with Puck copy", () => {
    const webEditor = platform("pages/admin/web-editor.tsx");
    expect(webEditor).toContain("Puck Web Editor");
    expect(webEditor).toContain("/api/admin/visual-editor");
    expect(webEditor).not.toContain("Plasmic");
    expect(webEditor).not.toContain("plasmic-host");
  });
});

describe("catalog/inventory/par/order source of truth", () => {
  it("inventory balance edits validate schema, check tenant ownership, and recompute catalog totals", () => {
    const inventory = api("routes/inventory.ts");
    expect(inventory).toContain("inventoryBalancesTable");
    expect(inventory).toContain(".strict().safeParse(req.body)");
    expect(inventory).toContain('Catalog product not found for this tenant');
    expect(inventory).toContain('Inventory location not found for this tenant');
    expect(inventory).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
    expect(inventory).toContain("eq(inventoryLocationsTable.tenantId, houseTenantId)");
    expect(inventory).toContain("recomputeCatalogInventoryTotals(houseTenantId, productId)");
    const balances = api("lib/inventoryBalances.ts");
    expect(balances).toContain("stockQuantity: String(totals?.qty");
    expect(balances).toContain("inventoryAmount: String(totals?.qty");
    expect(balances).toContain("parLevel: String(totals?.par");
  });

  it("catalog stock edits mirror into inventory balances instead of trusting catalog totals", () => {
    const catalog = api("routes/catalog.ts");
    expect(catalog).toContain("mirrorCatalogStockToBackstockAndRecompute");
    expect(catalog).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
    expect(catalog).toContain("quantityOnHand: String(stockQuantity)");
    expect(catalog).toContain("inventoryAmount: String(totals?.qty");
  });

  it("legacy shift inventory balance override rejects unknown fields and is tenant scoped", () => {
    const shifts = api("routes/shifts.ts");
    expect(shifts).toContain(".strict().safeParse(req.body)");
    expect(shifts).toContain("Balance not found for this tenant");
    expect(shifts).toContain("eq(inventoryBalancesTable.tenantId, houseTenantId)");
    expect(shifts).toContain("innerJoin(catalogItemsTable, eq(inventoryBalancesTable.productId, catalogItemsTable.id))");
    expect(shifts).toContain("innerJoin(inventoryLocationsTable, eq(inventoryBalancesTable.locationId, inventoryLocationsTable.id))");
    expect(shifts).toContain("await db.update(inventoryBalancesTable).set(update)");
    expect(shifts).toContain("recomputeCatalogInventoryTotals(houseTenantId, current.productId)");
    expect(shifts).toContain("await writeAuditLog({");
    expect(shifts).toContain('action: "INVENTORY_BALANCE_ADJUSTED"');
  });

  it("order creation decrements inventory balances and syncs catalog inventory fields", () => {
    const orders = api("routes/orders.ts");
    expect(orders).toContain("db.transaction");
    expect(orders).toContain("order = await db.transaction(async (tx) => {");
    expect(orders).toContain("await tx.insert(ordersTable).values");
    expect(orders).toContain("await tx.insert(orderItemsTable).values");
    expect(orders).toContain("quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(line.quantity)}`");
    expect(orders).toContain("${inventoryBalancesTable.quantityOnHand} >= ${String(line.quantity)}");
    expect(orders).not.toContain("GREATEST(${inventoryBalancesTable.quantityOnHand} -");
    expect(orders).toContain("InsufficientInventoryError");
    expect(orders).toContain("throw new InsufficientInventoryError(line.catalog_item_id)");
    expect(orders).toContain('res.status(409).json({ error: "Insufficient inventory"');
    expect(orders).toContain("await tx.execute(sql`");
    expect(orders).toContain("UPDATE catalog_items");
    expect(orders).toContain("stock_quantity = COALESCE");
    expect(orders).toContain("inventory_amount = COALESCE");
    expect(orders).toContain("WHERE tenant_id = ${houseTenantId}");
    expect(orders).toContain('eq(labTechShiftsTable.status, "active")');
    expect(orders).toContain("inventoryLocationNameForBoxAssignment(activeShift?.boxAssignmentId)");
    expect(orders).toContain("eq(inventoryLocationsTable.name, locationName)");
    expect(orders).toContain("eq(inventoryLocationsTable.tenantId, houseTenantId)");
    expect(orders).toContain("sellableInventoryBalancePredicate(houseTenantId)");
  });

  it("awaits converted checkout snapshot construction before order metadata and persistence use it", () => {
    const orders = api("routes/orders.ts");
    expect(orders).toContain("const preview = await buildConversionPreview(normalizedLines, body.data.confirmation);");
    expect(orders).toContain("confirmedAt: preview.confirmation.confirmedAt");
    expect(orders).toContain("total: preview.pricingSnapshot.total");
    expect(orders).toContain("const conversionSnapshotForOrder = isConversionPreviewSnapshot(conversionSnapshot)");
    expect(orders).toContain(": await buildConversionPreview(normalizedLines, {");
    expect(orders).not.toContain("conversionSnapshot as ReturnType<typeof buildConversionPreview>");
  });

  it("order creation denies cross-tenant catalog IDs before inventory decrement", () => {
    const orders = api("routes/orders.ts");
    expect(orders).toContain("One or more catalog items were not found for this tenant");
    expect(orders).toContain("inArray(catalogItemsTable.id, normalizedCatalogIds)");
    expect(orders).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
  });
  it("surfaces orphan and non-sellable inventory balances in an admin quarantine report", () => {
    const inventory = api("routes/inventory.ts");
    const balances = api("lib/inventoryBalances.ts");
    const dbSchema = src("lib/db/src/schema/shifts.ts");
    const platformInventory = platform("pages/admin/inventory.tsx");

    expect(dbSchema).toContain('inventoryKind: text("inventory_kind")');
    expect(dbSchema).toContain('isSellable: boolean("is_sellable")');
    expect(dbSchema).toContain('quarantinedAt: timestamp("quarantined_at"');
    expect(balances).toContain("getOrphanInventoryBalanceReport");
    expect(balances).toContain("sellableInventoryBalancePredicate");
    expect(balances).toContain("leftJoin(catalogItemsTable");
    expect(balances).toContain("non_sellable_supply");
    expect(inventory).toContain('"/admin/inventory/orphans"');
    expect(inventory).toContain('z.enum(["sellable_catalog", "non_sellable_supply"])');
    expect(platformInventory).toContain("Inventory quarantine report");
    expect(platformInventory).toContain("Mark supply");
  });

});

describe("receipts and deploy workflow", () => {
  it("centralizes receipt and printer sections", () => {
    const receipts = platform("pages/admin/receipts.tsx");
    for (const label of ["Receipts & Printers", "Reprint Receipts", "Templates", "Printers", "Routing", "Test Print"]) {
      expect(receipts).toContain(label);
    }
    expect(receipts).toContain("Printer hardware must be configured");
  });

  it("uses safer deploy flow and OAuth Tailscale tags", () => {
    const deploy = src(".github/workflows/deploy.yml");
    for (const required of ["VPS_KNOWN_HOSTS", "VPS_HOST_FALLBACK", "VPS_HOST_FALLBACK_PORT", "SELECTED_VPS_HOST", "SELECTED_VPS_PORT", "tags: tag:github-actions"]) {
      expect(deploy).toContain(required);
    }
    expect(deploy).toContain("secrets.VPS_USERNAME || secrets.VPS_USER || 'serveradmin'");
    expect(deploy).toContain("allow src tag:github-actions to SSH as ${VPS_USER}");
    expect(deploy).toContain("DEPLOY_PATH: /opt/alavont");
    expect(deploy).toContain("COMPOSE_PROJECT_NAME: alavont");
    expect(deploy).toContain('cd "${DEPLOY_PATH}/deploy"');
    expect(deploy).toContain("Deploy path: ${DEPLOY_PATH}/deploy");
    expect(deploy).toContain("Compose project: ${COMPOSE_PROJECT_NAME}");
    expect(deploy).toContain("docker compose build --pull");
    expect(deploy).toContain("docker compose up -d db");
    expect(deploy).toContain("docker compose run --rm migrate");
    expect(deploy).toContain("docker compose up -d api platform nginx");
    expect(deploy).toContain("docker compose ps");
    expect(deploy).toContain("curl -fsS http://127.0.0.1/api/healthz");
    expect(deploy).toContain("curl -fsS --connect-timeout 10 --max-time 20 https://myorder.fun/api/healthz");
    expect(deploy).not.toMatch(/docker compose down/);
    expect(deploy).not.toContain("/root/lux-email-bot");
    expect(deploy).not.toContain("luxit.service");
  });

  it("repo audit delegates committed secret value detection to the script", () => {
    const workflow = src(".github/workflows/repo-audit.yml");
    const auditScript = src("scripts/audit-secrets.sh");
    expect(workflow).toContain("bash scripts/audit-secrets.sh");
    expect(workflow).not.toContain("grep -R");
    expect(auditScript).toContain("git ls-files");
    expect(auditScript).toContain(".env.example");
    expect(auditScript).toContain("deploy/docker-compose.yml");
    expect(auditScript).toContain(".github/workflows/repo-audit.yml");
    expect(auditScript).toContain("process.env");
    expect(auditScript).toContain("is_placeholder()");
    expect(auditScript).toContain("looks_real_secret()");
    expect(auditScript).toContain("Secret audit failed. Real-looking committed secret values were found");
    expect(auditScript).toContain("OPENAI_API_KEY)");
    expect(auditScript).toContain("DATABASE_URL)");
    expect(auditScript).toContain("postgres(ql)?://");
  });
});

describe("shift wording compatibility", () => {
  const staff = platform("pages/staff.tsx");
  const shifts = api("routes/shifts.ts");

  it("uses commission-safe Start Shift / End Shift UI copy while retaining backend route compatibility", () => {
    expect(staff).toContain("Start Shift");
    expect(staff).toContain("End Shift");
    expect(staff).toContain('"/api/shifts/clock-in"');
    expect(staff).toContain('"/api/shifts/clock-out"');
    expect(shifts).toContain('"/shifts/clock-in"');
    expect(shifts).toContain('"/shifts/clock-out"');
  });
});

describe("role permission route integration", () => {
  const routesIndex = api("routes/index.ts");
  const rolePermissions = api("routes/role-permissions.ts");

  it("mounts the tenant-scoped role permission router without falling back to the legacy duplicate mount", () => {
    expect(routesIndex).toContain('import rolePermissionsRouter from "./role-permissions"');
    expect(routesIndex).toContain("router.use(rolePermissionsRouter)");
    expect(routesIndex).not.toContain('import permissionsRouter from "./permissions"');
    expect(routesIndex).not.toContain("router.use(permissionsRouter)");
  });

  it("keeps role permission APIs scoped, strict, permission-gated, and audit logged", () => {
    expect(rolePermissions).toContain("router.use(requireAuth, loadDbUser, requireDbUser, requireApproved)");
    expect(rolePermissions).toContain('requirePermission("users.manage_permissions")');
    expect(rolePermissions).toContain(".strict()");
    expect(rolePermissions).toContain("Tenant admins cannot modify another tenant's permissions");
    expect(rolePermissions).toContain("Tenant admins cannot edit global_admin permissions");
    expect(rolePermissions).toContain("Tenant admins cannot grant platform permissions");
    expect(rolePermissions).toContain("permissionAuditLogsTable");
  });
});

describe("admin/POS/security cleanup regressions", () => {
  it("repairs orders shift-routing schema drift before shift routes run", () => {
    const shifts = api("routes/shifts.ts");
    const migration = src("lib/db/drizzle/0027_orders_shift_schema_drift.sql");
    expect(shifts).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_shift_id"');
    expect(shifts).toContain('CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx"');
    expect(shifts).toContain("router.use(async (_req, res, next) =>");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "assigned_shift_id" integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "orders_assigned_shift_idx"');
    expect(migration.replace(/^--.*$/gm, "")).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });

  it("repairs orders lifecycle schema drift before shift current and clock-in can query orders", () => {
    const shifts = api("routes/shifts.ts");
    expect(shifts).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz');
    expect(shifts).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz');
    expect(shifts).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz');
    expect(shifts).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz');
    expect(shifts).toContain('CREATE INDEX IF NOT EXISTS "orders_archived_at_idx"');
    expect(shifts).toContain('CREATE INDEX IF NOT EXISTS "orders_voided_at_idx"');
    expect(shifts).toContain('CREATE INDEX IF NOT EXISTS "orders_cancelled_at_idx"');
    expect(shifts).toContain('CREATE INDEX IF NOT EXISTS "orders_completed_at_idx"');
    expect(shifts).toContain('"/shifts/current"');
    expect(shifts).toContain('"/shifts/clock-in"');
  });

  it("repairs orders lifecycle schema drift before shift queue orders can query orders", () => {
    const queue = api("routes/shift-queue.ts");
    expect(queue).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz');
    expect(queue).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz');
    expect(queue).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz');
    expect(queue).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz');
    expect(queue).toContain('CREATE INDEX IF NOT EXISTS "orders_archived_at_idx"');
    expect(queue).toContain('router.get("/shift-queue/orders"');
  });

  it("repairs missing shift_routing_config and falls back when tenant row is absent", () => {
    const migration = src("lib/db/drizzle/0029_shift_routing_config_repair.sql");
    const orderRouting = api("lib/orderRouting.ts");
    const shifts = api("routes/shifts.ts");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "shift_routing_config"');
    for (const column of ["id", "tenant_id", "allow_multiple_active_shifts", "routing_strategy", "approved_by_user_id", "approved_at", "reason", "created_at", "updated_at"]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toContain("DEFAULT 'round_robin'");
    expect(migration).toContain("default system fallback");
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "shift_routing_config_tenant_idx"');
    expect(orderRouting).toContain("ensureShiftRoutingConfigSchema");
    expect(orderRouting).toContain("approved ?? ({ routingStrategy: rule === ");
    expect(shifts).toContain('CREATE TABLE IF NOT EXISTS "shift_routing_config"');
    expect(migration.replace(/^--.*$/gm, "")).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });

  it("separates admin conversion preview from customer-safe receipt copy", () => {
    const orders = api("routes/orders.ts");
    const newOrder = platform("pages/new-order.tsx");
    expect(orders).toContain("originalInternalName: line.catalog_display_name");
    expect(newOrder).toContain(">Before<");
    expect(newOrder).toContain(">After<");
    expect(newOrder).toContain("converted?.customerSafeName ?? converted?.displayName ?? item.name");
    expect(newOrder).not.toContain("Safe Category:");
  });

  it("includes an idempotent non-destructive migration for orders lifecycle columns", () => {
    const migration = src("lib/db/drizzle/0028_orders_lifecycle_schema_drift.sql");
    for (const column of ["archived_at", "archived_by_user_id", "voided_at", "voided_by_user_id", "cancelled_at", "cancelled_by_user_id", "completed_at", "completed_by_user_id"]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    for (const indexName of ["orders_archived_at_idx", "orders_voided_at_idx", "orders_cancelled_at_idx", "orders_completed_at_idx"]) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS "${indexName}"`);
    }
    expect(migration).toContain("Rollback notes only");
    expect(migration.replace(/^--.*$/gm, "")).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });

  it("requires explicit CSR setup acknowledgements before clock-in", () => {
    const shifts = api("routes/shifts.ts");
    const staff = platform("pages/staff.tsx");
    expect(shifts).toContain('Clock-in requires WiFi, printer, and pickup/location acknowledgements');
    expect(staff).toContain('I confirm WiFi is working');
    expect(staff).toContain('I confirm printer is available');
    expect(staff).toContain('I confirm pickup/location is set');
    expect(staff).toContain('disabled={clocking || !mandatoryChecksComplete}');
  });

  it("keeps featured AI products admin-only and blocks non-admin callers", () => {
    const settings = api("routes/settings.ts");
    expect(settings).toContain('router.put("/admin/concierge/promoted", requireRole("global_admin", "admin"');
    expect(settings).not.toContain('router.put("/admin/concierge/promoted", requireRole("global_admin", "admin", "supervisor"');
  });

  it("documents and enforces personal delivery fee and 2-mile limit", () => {
    const orders = api("routes/orders.ts");
    const newOrder = platform("pages/new-order.tsx");
    expect(orders).toContain('csrDeliveryDistanceMiles > 2');
    expect(orders).toContain('CSR personal delivery is only available within 2 miles');
    expect(orders).toContain('Math.round((6 + 0.03 * merchandiseTotal) * 100) / 100');
    expect(newOrder).toContain('$6 + 3% of sale total');
  });


  it("documents that this PR is partial and does not complete POS import operations", () => {
    const notes = src("docs/admin-pos-security-supporting-pr-notes.md");
    expect(notes).toContain("partial supporting admin/POS/security regression PR");
    expect(notes).toContain("importer-side duplicate Product Master repair");
    expect(notes).toContain("35-row Product Master import creates 140 `inventory_balances` rows");
    expect(notes).toContain("must not be used to mark POS operational by itself");
  });

  it("adds privacy copy/print/background deterrence on protected screens", () => {
    const sensitive = platform("components/privacy/SensitiveScreen.tsx");
    expect(sensitive).toContain('copy_blocked');
    expect(sensitive).toContain('beforeprint');
    expect(sensitive).toContain('sensitive_screen_hidden_on_blur');
    expect(sensitive).toContain('route ??');
  });
});
