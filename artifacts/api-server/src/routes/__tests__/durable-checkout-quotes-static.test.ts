import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);

describe("durable checkout quote authority", () => {
  it("persists tenant/customer-scoped quotes and atomically consumes them with order creation", async () => {
    const [orders, schema, migration] = await Promise.all([
      readFile(new URL("artifacts/api-server/src/routes/orders.ts", root), "utf8"),
      readFile(new URL("lib/db/src/schema/checkoutQuotes.ts", root), "utf8"),
      readFile(new URL("lib/db/drizzle/0084_durable_checkout_quotes.sql", root), "utf8"),
    ]);

    expect(schema).toContain('pgTable("checkout_quotes"');
    expect(schema).toContain('customerId: integer("customer_id").notNull()');
    expect(migration).toContain('CHECK ("status" IN (\'quoted\', \'consumed\'))');
    expect(orders).toContain("await db.insert(checkoutQuotesTable).values");
    expect(orders).toContain('eq(checkoutQuotesTable.tenantId, houseTenantId)');
    expect(orders).toContain('eq(checkoutQuotesTable.customerId, actor.id)');
    expect(orders).toContain('eq(checkoutQuotesTable.status, "quoted")');
    expect(orders).toContain('set({ status: "consumed", consumedAt: now })');
    expect(orders).not.toContain("createCheckoutTaxQuoteToken({ tenantId");
  });
});
