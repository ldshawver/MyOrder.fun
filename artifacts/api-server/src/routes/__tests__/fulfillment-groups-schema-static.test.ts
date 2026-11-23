import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);

describe("mixed-cart fulfillment group persistence", () => {
  it("binds immutable tenant/order groups and their lines without rewriting history", async () => {
    const [schema, migration, orderRoute] = await Promise.all([
      readFile(new URL("lib/db/src/schema/orders.ts", root), "utf8"),
      readFile(new URL("lib/db/drizzle/0085_order_fulfillment_groups.sql", root), "utf8"),
      readFile(new URL("artifacts/api-server/src/routes/orders.ts", root), "utf8"),
    ]);

    expect(schema).toContain('pgTable("order_fulfillment_groups"');
    expect(schema).toContain('name: "order_fulfillment_groups_tenant_order_fk"');
    expect(schema).toContain('name: "order_items_fulfillment_group_order_fk"');
    expect(migration).toContain('UNIQUE ("order_id", "group_key")');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "order_id")');
    expect(migration).toContain('FOREIGN KEY ("order_id", "fulfillment_group_id")');
    expect(migration).toContain('CHECK ("provider" IN (\'alavont\', \'lucifer_direct\', \'cj\'))');
    expect(migration).toContain('CHECK ("method" IN (\'pickup\', \'uber_direct\', \'csr_delivery\', \'carrier\', \'standard_shipping\'))');
    expect(migration).toContain('"fulfillment_group_id" integer');
    expect(migration).not.toContain('"fulfillment_group_id" integer NOT NULL');
    expect(orderRoute).toContain("planCheckoutFulfillmentGroups(normalizedLines, requestedDeliveryMethod)");
    expect(orderRoute).toContain("tx.insert(orderFulfillmentGroupsTable)");
    expect(orderRoute).toContain("fulfillmentGroupId: groupIdByLineIndex.get(lineIndex)");
    expect(orderRoute).toContain('error: "CASH_UNAVAILABLE_FOR_SHIPPING"');
    expect(orderRoute).toContain("const fulfillmentGroups = snapshotCheckoutFulfillmentGroups(fulfillmentGroupPlans");
    expect(orderRoute).toContain("quoteSnapshot?.fulfillmentGroups) === JSON.stringify(quotedFulfillmentGroups)");
    expect(orderRoute).toContain("res.json({ merchandiseSubtotal:");
    expect(orderRoute).toContain("pickup, fulfillmentGroups, tipAmount:");
  });
});
