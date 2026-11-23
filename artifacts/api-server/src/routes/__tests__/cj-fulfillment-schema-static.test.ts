import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);

describe("CJ provider fulfillment authority", () => {
  it("persists tenant/group-scoped provider identity and an idempotent event inbox", async () => {
    const [schema, exports, migration] = await Promise.all([
      readFile(new URL("lib/db/src/schema/cjFulfillment.ts", root), "utf8"),
      readFile(new URL("lib/db/src/schema/index.ts", root), "utf8"),
      readFile(new URL("lib/db/drizzle/0087_cj_fulfillment_events.sql", root), "utf8"),
    ]);

    expect(exports).toContain('export * from "./cjFulfillment"');
    expect(schema).toContain('pgTable("cj_order_fulfillments"');
    expect(schema).toContain('pgTable("cj_fulfillment_events"');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id")');
    expect(migration).toContain('FOREIGN KEY ("order_id", "fulfillment_group_id") REFERENCES "order_fulfillment_groups"("order_id", "id")');
    expect(migration).toContain('UNIQUE ("tenant_id", "fulfillment_group_id")');
    expect(migration).toContain('UNIQUE ("tenant_id", "provider_order_id")');
    expect(migration).toContain('UNIQUE ("tenant_id", "provider_event_id")');
    expect(migration).toContain('CHECK ("payload_sha256" ~ \'^[0-9a-f]{64}$\')');
    expect(migration).toContain("'reconciliation_required'");
  });
});
