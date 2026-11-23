import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildCatalogArchiveDryRunReport, quoteIdentifier } from "./catalog-archive-dry-run";

describe("catalog archive dry-run", () => {
  it("quotes PostgreSQL metadata identifiers", () => {
    assert.equal(quoteIdentifier('order"items'), '"order""items"');
  });

  it("blocks referenced rows and flags unprotected historical columns", async () => {
    const results = [
      [{ id: 7, tenantId: 2, name: "Archived item", sku: "A-7", archivedAt: "2026-01-01T00:00:00Z" }],
      [
        { schemaName: "public", tableName: "order_items", columnName: "catalog_item_id", constraintName: "order_items_catalog_fk", hasTenantId: true },
        { schemaName: "public", tableName: "legacy_lines", columnName: "catalog_item_id", constraintName: null, hasTenantId: false },
      ],
      [{ catalogItemId: 7, count: "3" }],
      [],
    ];
    let queryCount = 0;
    const executor = { execute: async (query: unknown) => {
      void query;
      queryCount += 1;
      return results.shift() ?? [];
    } };
    const report = await buildCatalogArchiveDryRunReport(executor as never, 2);

    assert.equal(report.mode, "read_only_dry_run");
    assert.equal(report.archivedItems[0]?.referenceCount, 3);
    assert.equal(report.archivedItems[0]?.purgeEligibility, "blocked_historical_references");
    assert.ok(report.warnings.includes("1 catalog reference column(s) have no discovered foreign key and require rehoming review."));
    assert.equal(queryCount, 4);
    const source = readFileSync(new URL("./catalog-archive-dry-run.ts", import.meta.url), "utf8");
    assert.match(source, /ref\.tenant_id = ci\.tenant_id/);
    assert.doesNotMatch(source, /(?:DELETE|UPDATE|INSERT)\s+(?:FROM|INTO|public\.)/i);
  });
});
