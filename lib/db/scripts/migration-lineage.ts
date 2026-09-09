export interface LineageMigration {
  idx: number;
  tag: string;
  when: number;
  hash: string;
}

export interface LineageAppliedMigration {
  id: number;
  hash: string;
  created_at: string;
}

export const legacyDev0038 = Object.freeze({
  index: 15,
  tag: "0038_general_queue_cash_sessions",
  when: 1785081600000,
  hash: "dfa97bc77b06b927c5744957df530e4844a312fc9b90d61f335b31bfb97245b6",
  reconciliationIndex: 16,
  reconciliationTag: "0039_general_queue_cash_schema_reconciliation",
  reconciliationHash:
    "37cef5f1b7f4fe255facd36743d83422e66fb5398d533d158f2cdd073ab8c079",
});

export const historicalStaging0047 = Object.freeze({
  index: 24,
  canonicalTag: "0047_inventory_receipts",
  canonicalHash:
    "b1c60f216d46ec620e0572f5c2b26dd64d7d9097f90139fa11ed54167a68d5d0",
  canonicalWhen: 1787504400000,
  historicalTag: "0047_catalog_import_preview_tokens",
  historicalHash:
    "6d61aa6e1b62cbc9de68109710afc7f3f54423fd1776c0103b18b95f2bb0b786",
  historicalWhen: 1788031800000,
  reconciledJournalIndices: [24, 25, 26] as const,
  shiftedRows: [
    {
      appliedIndex: 25,
      journalIndex: 27,
      tag: "0050_tenant_wide_tax_configuration",
      hash: "c1d72904c50fe1be928b115b112a4de7d093c016ad0caeab8069bb9b546c1ed2",
      when: 1788062400000,
    },
    {
      appliedIndex: 26,
      journalIndex: 28,
      tag: "0051_staging_inventory_receipts_reconciliation",
      hash: "4e156880b8651b10cca9e2a8a4293a319f203e36e0659e56e9d04fd569401813",
      when: 1788066000000,
    },
    {
      appliedIndex: 27,
      journalIndex: 29,
      tag: "0052_staging_sales_tax_paid_amount_reconciliation",
      hash: "1cceeb41d7eaf4243b4c94d4cfc9c45acae78f97016e0014ce2a3c7da2da7bdf",
      when: 1788069600000,
    },
  ] as const,
});

export const historicalStaging0047SchemaChecks = [
  "inventory_receipts_table",
  "inventory_receipts_columns",
  "inventory_receipts_defaults",
  "inventory_receipts_constraints",
  "inventory_receipts_index",
  "catalog_items_tenant_id_id_unique",
  "preview_tokens_table",
  "preview_tokens_columns",
  "preview_tokens_defaults",
  "preview_tokens_constraints",
  "preview_tokens_indexes",
] as const;

export type HistoricalStaging0047SchemaEvidence = Record<
  (typeof historicalStaging0047SchemaChecks)[number],
  boolean
>;

export function assertHistoricalStaging0047Schema(
  evidence: HistoricalStaging0047SchemaEvidence,
): void {
  const failed = historicalStaging0047SchemaChecks.filter(
    (check) => evidence[check] !== true,
  );
  if (failed.length > 0) {
    throw new Error(
      `[migration-ledger] historical staging 0047 schema verification failed: ${failed.join(", ")}`,
    );
  }
}

export interface AppliedLineageResult {
  legacyIndices: Set<number>;
  appliedJournalIndices: Set<number>;
  historicalStaging0047Recognized: boolean;
}

function matchesHistoricalStaging0047(
  local: LineageMigration[],
  applied: LineageAppliedMigration[],
): boolean {
  const lineage = historicalStaging0047;
  const canonical0047 = local[lineage.index];
  const canonical0048 = local[lineage.index + 1];
  const canonical0049 = local[lineage.index + 2];
  const historicalRow = applied[lineage.index];

  if (
    canonical0047?.idx !== lineage.index ||
    canonical0047.tag !== lineage.canonicalTag ||
    canonical0047.hash !== lineage.canonicalHash ||
    canonical0047.when !== lineage.canonicalWhen ||
    canonical0048?.idx !== lineage.index + 1 ||
    canonical0048.tag !== "0048_sales_tax_period_paid_amount" ||
    canonical0048.hash !== lineage.shiftedRows[2].hash ||
    canonical0048.when !== 1787508000000 ||
    canonical0049?.idx !== lineage.index + 2 ||
    canonical0049.tag !== "0049_catalog_import_preview_tokens" ||
    canonical0049.hash !== lineage.historicalHash ||
    canonical0049.when !== lineage.historicalWhen ||
    historicalRow?.hash !== lineage.historicalHash ||
    historicalRow.created_at !== String(lineage.historicalWhen)
  ) {
    return false;
  }

  return lineage.shiftedRows.every((row) => {
    const expected = local[row.journalIndex];
    const appliedRow = applied[row.appliedIndex];
    return (
      expected?.idx === row.journalIndex &&
      expected.tag === row.tag &&
      expected.hash === row.hash &&
      expected.when === row.when &&
      appliedRow?.hash === row.hash &&
      appliedRow.created_at === String(row.when)
    );
  });
}

export function validateAppliedLineage(
  local: LineageMigration[],
  applied: LineageAppliedMigration[],
): AppliedLineageResult {
  if (applied.length > local.length) {
    throw new Error(
      `[migration-ledger] database has ${applied.length} migrations but the journal has only ${local.length}`,
    );
  }

  const legacyIndices = new Set<number>();
  const appliedJournalIndices = new Set<number>();
  const historicalStaging0047Recognized = matchesHistoricalStaging0047(
    local,
    applied,
  );
  for (const [index, row] of applied.entries()) {
    const expected = historicalStaging0047Recognized
      ? index === historicalStaging0047.index
        ? undefined
        : index > historicalStaging0047.index
          ? local[index + 2]
          : local[index]
      : local[index];

    if (
      historicalStaging0047Recognized &&
      index === historicalStaging0047.index
    ) {
      legacyIndices.add(index);
      for (const journalIndex of historicalStaging0047.reconciledJournalIndices) {
        appliedJournalIndices.add(journalIndex);
      }
      continue;
    }

    if (!expected) {
      throw new Error(
        `[migration-ledger] database row ${index + 1} has no matching journal entry; refusing to migrate`,
      );
    }
    const canonical =
      row.hash === expected.hash && row.created_at === String(expected.when);
    if (canonical) {
      appliedJournalIndices.add(expected.idx);
      continue;
    }

    const legacy = legacyDev0038;
    const reconciliation = local[legacy.reconciliationIndex];
    const appliedReconciliation = applied[legacy.reconciliationIndex];
    const acceptedLegacyLineage =
      index === legacy.index &&
      expected.idx === legacy.index &&
      expected.tag === legacy.tag &&
      expected.when === legacy.when &&
      row.hash === legacy.hash &&
      row.created_at === String(legacy.when) &&
      reconciliation?.idx === legacy.reconciliationIndex &&
      reconciliation.tag === legacy.reconciliationTag &&
      reconciliation.hash === legacy.reconciliationHash &&
      appliedReconciliation?.hash === legacy.reconciliationHash &&
      appliedReconciliation.created_at === String(reconciliation.when);

    if (!acceptedLegacyLineage) {
      throw new Error(
        `[migration-ledger] database row ${index + 1} does not match journal entry ${expected.tag}; refusing to migrate`,
      );
    }
    legacyIndices.add(index);
    appliedJournalIndices.add(expected.idx);
  }
  return {
    legacyIndices,
    appliedJournalIndices,
    historicalStaging0047Recognized,
  };
}
