import { sql } from "drizzle-orm";

type QueryExecutor = { execute(query: ReturnType<typeof sql.raw>): Promise<unknown> };

type ArchivedCatalogRow = {
  id: number;
  tenantId: number;
  name: string;
  sku: string | null;
  archivedAt: string | null;
};

type ReferenceColumn = {
  schemaName: string;
  tableName: string;
  columnName: string;
  constraintName: string | null;
  hasTenantId: boolean;
};

export type CatalogArchiveDryRunReport = {
  generatedAt: string;
  mode: "read_only_dry_run";
  tenantId: number | null;
  archivedItems: Array<ArchivedCatalogRow & {
    referenceCount: number;
    references: Array<{ table: string; column: string; count: number; protectedByForeignKey: boolean }>;
    purgeEligibility: "blocked_historical_references" | "requires_manual_review";
  }>;
  discoveredReferenceColumns: Array<ReferenceColumn>;
  warnings: string[];
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

/** Quote an identifier discovered from PostgreSQL metadata, never user input. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid PostgreSQL reference count");
  return count;
}

export async function buildCatalogArchiveDryRunReport(
  executor: QueryExecutor,
  tenantId: number | null,
): Promise<CatalogArchiveDryRunReport> {
  const archived = rows<ArchivedCatalogRow>(await executor.execute(sql.raw(`
    SELECT id, tenant_id AS "tenantId", name, sku,
      NULLIF(metadata->>'archivedAt', '') AS "archivedAt"
    FROM public.catalog_items
    WHERE COALESCE(metadata->>'archived', 'false') = 'true'
      ${tenantId == null ? "" : `AND tenant_id = ${tenantId}`}
    ORDER BY tenant_id, id
  `)));

  const columns = rows<ReferenceColumn>(await executor.execute(sql.raw(`
    SELECT c.table_schema AS "schemaName", c.table_name AS "tableName",
      c.column_name AS "columnName", tc.constraint_name AS "constraintName",
      EXISTS (
        SELECT 1 FROM information_schema.columns tenant_column
        WHERE tenant_column.table_schema = c.table_schema
          AND tenant_column.table_name = c.table_name
          AND tenant_column.column_name = 'tenant_id'
      ) AS "hasTenantId"
    FROM information_schema.columns c
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name
      AND kcu.column_name = c.column_name
    LEFT JOIN information_schema.table_constraints tc
      ON tc.constraint_schema = kcu.constraint_schema
      AND tc.constraint_name = kcu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = 'public' AND ccu.table_name = 'catalog_items' AND ccu.column_name = 'id'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('catalog_item_id', 'product_id')
      AND c.table_name <> 'catalog_items'
      AND (ccu.column_name IS NOT NULL OR c.column_name = 'catalog_item_id')
    ORDER BY c.table_schema, c.table_name, c.column_name
  `)));

  const referencesByItem = new Map<number, CatalogArchiveDryRunReport["archivedItems"][number]["references"]>();
  for (const column of columns) {
    const table = `${quoteIdentifier(column.schemaName)}.${quoteIdentifier(column.tableName)}`;
    const referenceColumn = quoteIdentifier(column.columnName);
    const counts = rows<{ catalogItemId: number; count: string | number }>(await executor.execute(sql.raw(`
      SELECT ci.id AS "catalogItemId", COUNT(ref.*) AS count
      FROM public.catalog_items ci
      JOIN ${table} ref ON ref.${referenceColumn} = ci.id
      WHERE COALESCE(ci.metadata->>'archived', 'false') = 'true'
        ${tenantId == null ? "" : `AND ci.tenant_id = ${tenantId}`}
        ${column.hasTenantId ? "AND ref.tenant_id = ci.tenant_id" : ""}
      GROUP BY ci.id
    `)));
    for (const countRow of counts) {
      const list = referencesByItem.get(countRow.catalogItemId) ?? [];
      list.push({
        table: `${column.schemaName}.${column.tableName}`,
        column: column.columnName,
        count: parseCount(countRow.count),
        protectedByForeignKey: column.constraintName != null,
      });
      referencesByItem.set(countRow.catalogItemId, list);
    }
  }

  const unprotected = columns.filter(column => column.constraintName == null);
  return {
    generatedAt: new Date().toISOString(),
    mode: "read_only_dry_run",
    tenantId,
    archivedItems: archived.map(item => {
      const references = referencesByItem.get(item.id) ?? [];
      const referenceCount = references.reduce((total, reference) => total + reference.count, 0);
      return {
        ...item,
        referenceCount,
        references,
        purgeEligibility: referenceCount > 0 ? "blocked_historical_references" : "requires_manual_review",
      };
    }),
    discoveredReferenceColumns: columns,
    warnings: [
      "This report never authorizes deletion. Zero discovered references still requires schema-owner review and a backup/rollback plan.",
      ...(unprotected.length > 0
        ? [`${unprotected.length} catalog reference column(s) have no discovered foreign key and require rehoming review.`]
        : []),
    ],
  };
}

function parseTenantId(argv: string[]): number | null {
  const argument = argv.find(value => value.startsWith("--tenant-id="));
  if (!argument) return null;
  const value = Number(argument.slice("--tenant-id=".length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--tenant-id must be a positive integer");
  return value;
}

async function main(): Promise<void> {
  const tenantId = parseTenantId(process.argv.slice(2));
  const { db } = await import("@workspace/db");
  const report = await db.transaction(async tx => {
    await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
    return buildCatalogArchiveDryRunReport(tx, tenantId);
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`Catalog archive dry-run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
