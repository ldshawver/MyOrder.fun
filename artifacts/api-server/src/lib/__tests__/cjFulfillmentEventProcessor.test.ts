import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authenticated CJ fulfillment event processor", () => {
  it("keeps signed tenant identity and event replay authority server-side", async () => {
    const root = new URL("../../../../../", import.meta.url);
    const route = await readFile(new URL("artifacts/api-server/src/routes/woocommerce-webhooks.ts", root), "utf8");
    expect(route).toContain('const CJ_ORDER_TOPIC = "order.updated"');
    expect(route).toContain("verifyWooWebhookSignature(req.body, signature, secret)");
    expect(route).toContain("processAuthenticatedCjFulfillmentEvent({ tenantId, event: cjEvent, payloadSha256: payloadHash })");
    expect(route).toContain('reject(res, "delivery_id_payload_mismatch", 409)');
    expect(route).not.toContain("tenantId: eventData");
  });

  it("atomically locks provider identity, claims the inbox, and derives parent status", async () => {
    const root = new URL("../../../../../", import.meta.url);
    const source = await readFile(new URL("artifacts/api-server/src/lib/cjFulfillmentEventProcessor.ts", root), "utf8");
    expect(source).toContain("return db.transaction(async (tx)");
    expect(source).toContain('.for("update")');
    expect(source).toContain("tx.insert(cjFulfillmentEventsTable)");
    expect(source).toContain(".onConflictDoNothing()");
    expect(source).toContain("existing.payloadSha256 !== input.payloadSha256");
    expect(source).toContain('eq(orderFulfillmentGroupsTable.provider, "cj")');
    expect(source).toContain("deriveParentFulfillmentStatus");
    expect(source).toContain("processedAt: now");
  });
});
