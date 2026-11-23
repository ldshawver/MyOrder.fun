import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);

describe("Lucifer Direct carrier quote authority", () => {
  it("keeps provider rates server-side, tenant/customer scoped, expiring, and single-use", async () => {
    const [schema, exports, migration] = await Promise.all([
      readFile(new URL("lib/db/src/schema/carrierQuotes.ts", root), "utf8"),
      readFile(new URL("lib/db/src/schema/index.ts", root), "utf8"),
      readFile(new URL("lib/db/drizzle/0086_carrier_quotes.sql", root), "utf8"),
    ]);

    expect(exports).toContain('export * from "./carrierQuotes"');
    expect(schema).toContain('pgTable("carrier_quotes"');
    expect(schema).toContain('tenantId: integer("tenant_id").notNull()');
    expect(schema).toContain('customerId: integer("customer_id").notNull()');
    expect(schema).toContain('cartFingerprint: text("cart_fingerprint").notNull()');
    expect(schema).toContain('destinationSnapshot: jsonb("destination_snapshot").notNull()');
    expect(schema).toContain('serviceSnapshot: jsonb("service_snapshot").notNull()');
    expect(migration).toContain('UNIQUE ("tenant_id", "provider", "provider_quote_id")');
    expect(migration).toContain('CHECK ("fee_cents" >= 0)');
    expect(migration).toContain("CHECK (\"status\" IN ('quoted', 'consumed'))");
    expect(migration).toContain('("tenant_id", "customer_id", "status", "expires_at")');
  });

  it("exposes only an authenticated, server-grouped carrier quote path", async () => {
    const orders = await readFile(new URL("artifacts/api-server/src/routes/orders.ts", root), "utf8");
    expect(orders).toContain('"/checkout/carrier-quote",');
    expect(orders).toContain('router.post("/checkout/carrier-quote"');
    expect(orders).toContain("const lines = await normalizeCheckoutCart(");
    expect(orders).toContain("const eligibleLines = luciferDirectCarrierLines(lines);");
    expect(orders).toContain("tenantId,\n      customerId: actor.id,");
    expect(orders).toContain("requireConfiguredCarrierQuoteAdapter()");
    expect(orders).not.toContain("provider: parsed.data");
  });
});
