import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
});
