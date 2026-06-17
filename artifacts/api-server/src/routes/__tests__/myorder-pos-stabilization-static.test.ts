import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function forbiddenLegacyDeployPattern(): RegExp {
  const luxEmailBot = ["lux", "email", "bot"].join("-");
  const luxitService = ["luxit", "service"].join("\\.");
  const composeDown = ["docker compose", "down"].join("\\s+");
  return new RegExp(`${luxEmailBot}|${luxitService}|${composeDown}`);
}

describe("MyOrder POS stabilization static checks", () => {
  it("keeps deployment workflow on the MyOrder target and safe compose sequence", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");
    const combined = `${workflow}\n${readiness}`;

    expect(workflow).toContain("DEPLOY_PATH: /opt/alavont");
    expect(workflow).toContain("COMPOSE_PROJECT_NAME: alavont");
    expect(workflow).toContain("VPS_USERNAME");
    expect(workflow).toContain("VPS_USER");
    expect(workflow).toContain("serveradmin");
    expect(workflow).toContain("tag:github-actions");
    expect(workflow).toContain("Connect to Tailscale with OAuth");
    expect(workflow).not.toContain("TAILSCALE_AUTHKEY");
    expect(workflow).not.toContain("TS_AUTHKEY");
    expect(workflow).toContain("Selected VPS host:");
    expect(workflow).toContain("Selected VPS port:");
    expect(workflow).toContain("Selected deploy path:");
    expect(workflow).toContain("Selected compose project:");
    expect(combined).toContain("/opt/alavont/deploy");
    expect(workflow).toContain('cd "$DEPLOY_PATH/deploy"');

    const buildIndex = workflow.indexOf("docker compose build --pull");
    const dbIndex = workflow.indexOf("docker compose up -d db");
    const migrateIndex = workflow.indexOf("docker compose run --rm migrate");
    const appIndex = workflow.indexOf("docker compose up -d api platform nginx");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(dbIndex).toBeGreaterThan(buildIndex);
    expect(migrateIndex).toBeGreaterThan(dbIndex);
    expect(appIndex).toBeGreaterThan(migrateIndex);

    expect(workflow).toContain("docker compose ps");
    expect(workflow).toContain("curl -fsS http://127.0.0.1/api/healthz");
    expect(workflow).toContain("curl -fsS --connect-timeout 10 --max-time 20 https://myorder.fun/api/healthz");
    expect(combined).not.toMatch(forbiddenLegacyDeployPattern());
  });

  it("keeps repo audit guardrails for secret scanning", () => {
    const auditScript = read("scripts/audit-secrets.sh");

    expect(auditScript).toContain("git ls-files");
    expect(auditScript).toContain("Secret audit passed");
    expect(auditScript).not.toMatch(/grep\s+-R/);
    expect(auditScript).toContain("PLACEHOLDER_ALLOW_RE");
    expect(auditScript).toContain("REAL_SECRET_PATTERNS");
    expect(auditScript).toContain("OPENAI_API_KEY");
    expect(auditScript).toContain("STRIPE_SECRET_KEY");
    expect(auditScript).toContain("CLERK_SECRET_KEY");
    expect(auditScript).toContain("TWILIO_AUTH_TOKEN");
    expect(auditScript).toContain("SESSION_SECRET");
    expect(auditScript).toContain("DATABASE_URL");
    expect(auditScript).toContain("values suppressed");
  });

  it("guards lowercase csr as the canonical CSR role", () => {
    const auth = read("artifacts/api-server/src/lib/auth.ts");

    expect(auth).toContain('| "csr"');
    expect(auth).toContain('return "csr"');
    expect(auth).toContain('normalized === "customer_service_rep"');
    expect(auth).toContain('normalized === "service_rep"');
  });

  it("guards inventory/order source-of-truth and transaction safety", () => {
    const orders = read("artifacts/api-server/src/routes/orders.ts");
    const shifts = read("artifacts/api-server/src/routes/shifts.ts");
    const inventoryBalances = read("artifacts/api-server/src/lib/inventoryBalances.ts");
    const combined = `${orders}\n${shifts}\n${inventoryBalances}`;

    expect(combined).toContain("inventory_balances");
    expect(combined).toContain("inventoryBalancesTable");
    expect(shifts).toContain("recomputeCatalogInventoryMirror");
    expect(shifts).toContain("stockQuantity");
    expect(shifts).toContain("inventoryAmount");
    expect(shifts).toContain("parLevel");
    expect(orders).toContain("db.transaction");
    expect(orders).toContain("quantity_on_hand >=");
    expect(orders).toContain("INSUFFICIENT_INVENTORY");
    expect(orders).toContain("status(409)");
    expect(orders).toContain("CATALOG_ITEM_TENANT_MISMATCH");
    expect(orders).toContain("stockQuantity");
    expect(orders).toContain("inventoryAmount");
    expect(orders).not.toContain("GREATEST(0");
    expect(combined).toContain("tenantId");
    expect(combined).toContain("locationId");
  });

  it("guards shift inventory hardening and Start Shift / End Shift compatibility", () => {
    const shifts = read("artifacts/api-server/src/routes/shifts.ts");
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");

    expect(shifts).toContain('"/shifts/clock-in"');
    expect(shifts).toContain('"/shifts/clock-out"');
    expect(readiness).toContain("Start Shift / End Shift");
    expect(shifts).toContain("inventoryBalancesTable");
    expect(shifts).toContain("recomputeCatalogInventoryMirror");
    expect(shifts).toContain("writeAuditLog");
    expect(shifts).toContain("eq(inventoryBalancesTable.tenantId");
    expect(shifts).toContain("eq(inventoryBalancesTable.locationId");
  });

  it("guards catalog visibility and stock parsing fixes from PR #57", () => {
    const visibility = read("artifacts/api-server/src/lib/catalogVisibility.ts");
    const importer = read("artifacts/api-server/src/routes/import.ts");
    const catalog = read("artifacts/api-server/src/routes/catalog.ts");
    const inventory = read("artifacts/api-server/src/routes/inventory.ts");
    const shifts = read("artifacts/api-server/src/routes/shifts.ts");
    const combined = `${catalog}\n${inventory}\n${shifts}`;

    expect(visibility).toContain("isTrueWooCommerceStorefrontRow");
    expect(visibility).toContain("isVisibleAlavontCatalogRow");
    expect(visibility).toContain("visibleAlavontCatalogSql");
    expect(visibility).toContain("merchantProductSource");
    expect(visibility).toContain("wooProductId");
    expect(importer).toContain("parseStockStatus");
    expect(importer).toContain("In Stock");
    expect(importer).toContain("available");
    expect(combined).toContain("visibleAlavontCatalogSql");
  });

  it("guards removal of legacy contract/document hubs from active MyOrder runtime", () => {
    const apiIndex = read("artifacts/api-server/src/routes/index.ts");
    const app = read("artifacts/platform/src/App.tsx");
    const layout = read("artifacts/platform/src/components/layout.tsx");
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");
    const combined = `${apiIndex}
${app}
${layout}
${readiness}`;

    expect(combined).not.toContain("contractor-hub");
    expect(combined).not.toContain("document-hub");
    expect(combined).not.toContain("Contractor Hub");
    expect(combined).not.toContain("Document Hub");
    expect(combined).not.toContain("PublicContractSignPage");
    expect(combined).not.toContain("ContractSignPage");
    expect(combined).not.toContain("MyPayLink");
  });

  it("documents current MyOrder navigation/editor wording and avoids stale implementation terms", () => {
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");

    expect(readiness).toContain("Receipts & Printers");
    expect(readiness).toContain("Puck/Web Editor");
    expect(readiness).toContain("no SMS & Calls");
    expect(readiness).not.toContain("MyPayLink");
    expect(readiness).not.toContain("Document Hub");
    expect(readiness).not.toContain("Plasmic");
  });
});
