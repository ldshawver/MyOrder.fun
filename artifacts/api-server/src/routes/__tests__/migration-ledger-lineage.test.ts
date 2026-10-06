import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHistoricalStaging0047Schema,
  historicalStaging0047,
  historicalStaging0047SchemaChecks,
  legacyDev0038,
  validateAppliedLineage,
  type LineageAppliedMigration,
  type LineageMigration,
} from "../../../../../lib/db/scripts/migration-lineage";

const canonical0038 =
  "44028d841986512f0d7a348bd86db350b5ec3be52bf4de95730261f4776105fc";
const canonical0039 = legacyDev0038.reconciliationHash;

function chain(): LineageMigration[] {
  return Array.from({ length: 18 }, (_, idx) => ({
    idx,
    tag: `migration_${idx}`,
    when: 1780000000000 + idx * 1000,
    hash: `canonical_${idx}`,
  })).map((entry, idx) =>
    idx === 15
      ? {
          ...entry,
          tag: legacyDev0038.tag,
          when: legacyDev0038.when,
          hash: canonical0038,
        }
      : idx === 16
        ? {
            ...entry,
            tag: legacyDev0038.reconciliationTag,
            when: 1785510000000,
            hash: canonical0039,
          }
        : entry,
  );
}

function applied(
  local: LineageMigration[],
  count = 17,
): LineageAppliedMigration[] {
  return local.slice(0, count).map((entry, index) => ({
    id: index + 1,
    hash: entry.hash,
    created_at: String(entry.when),
  }));
}

function historical(local: LineageMigration[]): LineageAppliedMigration[] {
  const rows = applied(local);
  rows[15] = { ...rows[15], hash: legacyDev0038.hash };
  return rows;
}

function stagingChain(): LineageMigration[] {
  const local = Array.from({ length: 30 }, (_, idx) => ({
    idx,
    tag: `migration_${idx}`,
    when: 1780000000000 + idx * 1000,
    hash: `canonical_${idx}`,
  }));
  local[historicalStaging0047.index] = {
    idx: historicalStaging0047.index,
    tag: historicalStaging0047.canonicalTag,
    when: historicalStaging0047.canonicalWhen,
    hash: historicalStaging0047.canonicalHash,
  };
  local[25] = {
    idx: 25,
    tag: "0048_sales_tax_period_paid_amount",
    when: 1787508000000,
    hash: historicalStaging0047.shiftedRows[2].hash,
  };
  local[26] = {
    idx: 26,
    tag: "0049_catalog_import_preview_tokens",
    when: historicalStaging0047.historicalWhen,
    hash: historicalStaging0047.historicalHash,
  };
  for (const row of historicalStaging0047.shiftedRows) {
    local[row.journalIndex] = {
      idx: row.journalIndex,
      tag: row.tag,
      when: row.when,
      hash: row.hash,
    };
  }
  return local;
}

function historicalStagingApplied(
  local: LineageMigration[],
): LineageAppliedMigration[] {
  const rows = applied(local, 28);
  rows[historicalStaging0047.index] = {
    id: historicalStaging0047.index + 1,
    hash: historicalStaging0047.historicalHash,
    created_at: String(historicalStaging0047.historicalWhen),
  };
  for (const row of historicalStaging0047.shiftedRows) {
    rows[row.appliedIndex] = {
      id: row.appliedIndex + 1,
      hash: row.hash,
      created_at: String(row.when),
    };
  }
  return rows;
}

function verifiedHistoricalStagingSchema() {
  return Object.fromEntries(
    historicalStaging0047SchemaChecks.map((check) => [check, true]),
  ) as Record<(typeof historicalStaging0047SchemaChecks)[number], boolean>;
}

describe("strict migration lineage validation", () => {
  it("pins the archived historical DEV SQL bytes", () => {
    const artifact = resolve(
      import.meta.dirname,
      "../../../../../lib/db/migration-lineage/0038_general_queue_cash_sessions.legacy-dev.sql",
    );
    expect(
      createHash("sha256").update(readFileSync(artifact)).digest("hex"),
    ).toBe(legacyDev0038.hash);
  });

  it("accepts canonical 0038 followed by canonical 0039", () => {
    expect(
      validateAppliedLineage(chain(), applied(chain())).legacyIndices.size,
    ).toBe(0);
  });

  it("accepts the exact historical DEV 0038 followed by canonical 0039", () => {
    expect(
      validateAppliedLineage(chain(), historical(chain())).legacyIndices,
    ).toEqual(new Set([15]));
  });

  it("rejects an unknown 0038 checksum", () => {
    const rows = applied(chain());
    rows[15].hash = "unknown";
    expect(() => validateAppliedLineage(chain(), rows)).toThrow(/row 16/);
  });

  it("rejects historical DEV 0038 with the wrong timestamp", () => {
    const rows = historical(chain());
    rows[15].created_at = "1785081600001";
    expect(() => validateAppliedLineage(chain(), rows)).toThrow(/row 16/);
  });

  it("rejects historical DEV 0038 without applied 0039", () => {
    expect(() =>
      validateAppliedLineage(chain(), historical(chain()).slice(0, 16)),
    ).toThrow(/row 16/);
  });

  it("rejects historical DEV 0038 followed by a modified 0039", () => {
    const rows = historical(chain());
    rows[16].hash = "modified-0039";
    expect(() => validateAppliedLineage(chain(), rows)).toThrow(/row 16/);
  });

  it("rejects the historical checksum at another tag/index", () => {
    const rows = applied(chain());
    rows[14].hash = legacyDev0038.hash;
    expect(() => validateAppliedLineage(chain(), rows)).toThrow(/row 15/);
  });

  it("rejects an alternate checksum for another migration", () => {
    const rows = applied(chain());
    rows[3].hash = "alternate";
    expect(() => validateAppliedLineage(chain(), rows)).toThrow(/row 4/);
  });

  it("keeps an empty fresh database on the canonical journal only", () => {
    expect(validateAppliedLineage(chain(), []).legacyIndices.size).toBe(0);
  });

  it("accepts a canonical 0047 lineage without the staging exception", () => {
    const result = validateAppliedLineage(
      stagingChain(),
      applied(stagingChain()),
    );
    expect(result.historicalStaging0047Recognized).toBe(false);
    expect(result.legacyIndices.has(historicalStaging0047.index)).toBe(false);
  });

  it("accepts only the exact recovered staging 0047 lineage", () => {
    const local = stagingChain();
    const result = validateAppliedLineage(
      local,
      historicalStagingApplied(local),
    );
    expect(result.historicalStaging0047Recognized).toBe(true);
    expect(result.legacyIndices).toContain(historicalStaging0047.index);
    expect(result.appliedJournalIndices).toEqual(
      new Set(Array.from({ length: 30 }, (_, index) => index)),
    );
  });

  it("rejects the staging historical hash changed by one character", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    rows[historicalStaging0047.index].hash =
      `${historicalStaging0047.historicalHash.slice(0, -1)}0`;
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 25/);
  });

  it("rejects the staging historical timestamp changed by one millisecond", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    rows[historicalStaging0047.index].created_at = String(
      historicalStaging0047.historicalWhen + 1,
    );
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 25/);
  });

  it("rejects a shifted 0050 hash mismatch", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    rows[25].hash = "modified-0050";
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 25/);
  });

  it("rejects a shifted 0051 timestamp mismatch", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    rows[26].created_at = String(historicalStaging0047.shiftedRows[1].when + 1);
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 25/);
  });

  it("rejects a shifted migration order mismatch", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    [rows[25], rows[26]] = [rows[26], rows[25]];
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 25/);
  });

  it("fails closed for every missing historical staging schema invariant", () => {
    for (const check of historicalStaging0047SchemaChecks) {
      const evidence = verifiedHistoricalStagingSchema();
      evidence[check] = false;
      expect(() => assertHistoricalStaging0047Schema(evidence)).toThrow(check);
    }
  });

  it("accepts the historical 0047 schema after the explicit 0054 receipt additions", () => {
    // The SQL verifier permits only the enumerated 0054 additions; its boolean
    // evidence must still be accepted by the fail-closed lineage assertion.
    expect(() => assertHistoricalStaging0047Schema(verifiedHistoricalStagingSchema())).not.toThrow();

    const validator = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../../../lib/db/scripts/validate-migration-ledger.ts",
      ),
      "utf8",
    );
    expect(validator).toContain("(13, 'actual_unit_cost', 'numeric', true)");
    expect(validator).toContain("(16, 'movement_id', 'int4', true)");
    expect(validator).toContain("inventory_receipts_movement_id_fkey");
    expect(validator).not.toMatch(
      /count\(\*\)[\s\S]{0,180}table_name='inventory_receipts'\)\s*=\s*12/,
    );
  });

  it("rejects an arbitrary alternate historical migration mismatch", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    rows[10].hash = historicalStaging0047.historicalHash;
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 11/);
  });

  it("rejects an unrelated canonical journal mismatch", () => {
    const local = stagingChain();
    const rows = historicalStagingApplied(local);
    local[3] = { ...local[3], hash: "modified-canonical-journal" };
    expect(() => validateAppliedLineage(local, rows)).toThrow(/row 4/);
  });

  it("keeps the validator read-only with no migration-ledger write statement", () => {
    const validator = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../../../lib/db/scripts/validate-migration-ledger.ts",
      ),
      "utf8",
    );
    expect(validator).toContain('client.query("BEGIN READ ONLY")');
    expect(validator).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+drizzle\.__drizzle_migrations\b/i,
    );
  });
});
