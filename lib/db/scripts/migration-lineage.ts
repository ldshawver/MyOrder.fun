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

export interface AppliedLineageResult {
  legacyIndices: Set<number>;
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
  for (const [index, row] of applied.entries()) {
    const expected = local[index];
    const canonical =
      row.hash === expected.hash && row.created_at === String(expected.when);
    if (canonical) continue;

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
  }
  return { legacyIndices };
}
