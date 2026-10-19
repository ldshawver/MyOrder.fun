import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, fetch: vi.fn() }));

vi.mock("@workspace/db", () => {
  const adminSettingsTable = { tenantId: "tenantId", wcEnabled: "wcEnabled", wcStoreUrl: "wcStoreUrl", wcConsumerKey: "wcConsumerKey", wcConsumerSecret: "wcConsumerSecret" };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => mock.row ? [mock.row] : []);
  return { adminSettingsTable, db: { select: vi.fn(() => chain) } };
});

vi.mock("drizzle-orm", () => ({ eq: vi.fn((column, value) => ({ column, value })) }));
vi.mock("../../lib/wooSafeHttp", () => ({ fetchWooSafely: mock.fetch }));

import { db } from "@workspace/db";
import { fetchWooSafely } from "../../lib/wooSafeHttp";
import { checkWooCommerce } from "../integrations";

describe("WooCommerce integration health policy", () => {
  beforeEach(() => {
    process.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "true";
    mock.row = { enabled: true, storeUrl: "https://store.example", consumerKey: "key", consumerSecret: "secret" };
    vi.mocked(db.select).mockClear();
    vi.mocked(fetchWooSafely).mockReset();
  });

  it("does not query tenant credentials or issue the health probe while disabled", async () => {
    process.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "false";
    await expect(checkWooCommerce(1)).resolves.toBe("missing_config");
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWooSafely)).not.toHaveBeenCalled();
  });

  it("retains the read-only system-status probe when explicitly enabled", async () => {
    vi.mocked(fetchWooSafely).mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(checkWooCommerce(1)).resolves.toBe("connected");
    expect(vi.mocked(fetchWooSafely)).toHaveBeenCalledTimes(1);
  });
});
