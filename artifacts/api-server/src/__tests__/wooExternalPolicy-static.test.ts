import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("WooCommerce production-only staging boundary", () => {
  it("guards all external request entry points server-side", () => {
    expect(read("../lib/wooSafeHttp.ts")).toMatch(/isWooCommerceExternalIntegrationEnabled\(\).*disabled/s);
    expect(read("../lib/wooClient.ts")).toMatch(/isWooCommerceExternalIntegrationEnabled/);
    expect(read("../routes/woocommerce.ts")).toMatch(/syncHandler[\s\S]*isWooCommerceExternalIntegrationEnabled/);
    expect(read("../routes/woocommerce.ts")).toMatch(/\/admin\/woocommerce\/test[\s\S]*isWooCommerceExternalIntegrationEnabled/);
    expect(read("../routes/integrations.ts")).toMatch(/checkWooCommerce[\s\S]*isWooCommerceExternalIntegrationEnabled/);
    expect(read("../routes/woocommerce-webhooks.ts")).toMatch(/external_integration_disabled/);
  });

  it("requires process policy at service startup and keeps it out of the client bundle", () => {
    expect(read("../index.ts")).toMatch(/assertWooCommerceExternalIntegrationPolicy\(\)/);
    expect(read("../../../../deploy/docker-compose.staging.yml")).toMatch(/WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED: \$\{WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED:\?/);
    expect(read("../../../../deploy/docker-compose.staging.yml")).not.toMatch(/STAGING_WOOCOMMERCE_ORIGIN/);
  });
});
