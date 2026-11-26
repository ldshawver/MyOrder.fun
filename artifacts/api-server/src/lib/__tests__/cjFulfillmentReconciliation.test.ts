import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCjPollingSnapshot } from "../cjFulfillmentReconciliation";

describe("CJ provider polling reconciliation", () => {
  it("accepts only supported provider state and normalizes Woo hold state", () => {
    expect(parseCjPollingSnapshot({ id: 42, status: "on-hold", date_modified_gmt: "2026-11-23T12:00:00", ignored: "provider detail" })).toEqual({
      providerOrderId: "42", status: "on_hold", occurredAt: new Date("2026-11-23T12:00:00Z"),
    });
    expect(() => parseCjPollingSnapshot({ id: 42, status: "trash", date_modified_gmt: "2026-11-23T12:00:00" })).toThrow();
    expect(() => parseCjPollingSnapshot({ id: "../42", status: "processing", date_modified_gmt: "2026-11-23T12:00:00" })).toThrow();
  });

  it("bounds tenant work and routes snapshots through durable provider-event authority", async () => {
    const root = new URL("../../../../../", import.meta.url);
    const source = await readFile(new URL("artifacts/api-server/src/lib/cjFulfillmentReconciliation.ts", root), "utf8");
    expect(source).toContain("MAX_RECONCILIATION_BATCH = 25");
    expect(source).toContain("eq(adminSettingsTable.tenantId, tenantId)");
    expect(source).toContain("safeDecrypt(settings?.consumerKey)");
    expect(source).toContain("fetchWooSafely(storeUrl, `/wp-json/wc/v3/orders/${providerOrderId}`");
    expect(source).toContain("eq(cjOrderFulfillmentsTable.tenantId, input.tenantId)");
    expect(source).toContain('["pending", "reconciliation_required"]');
    expect(source).toContain("snapshot.providerOrderId !== candidate.providerOrderId");
    expect(source).toContain("processAuthenticatedCjFulfillmentEvent");
    expect(source).toContain('eventType: "provider.poll"');
    expect(source).not.toContain("req.dbUser");
  });
});
