import { createHash } from "node:crypto";
import type pg from "pg";

export type SchemaObject = { kind: string; key: string; digest: string };
export function schemaFingerprint(objects: SchemaObject[]): string {
  return createHash("sha256").update(objects.map(row => `${row.kind}|${row.key}|${row.digest}`).sort().join("\n")).digest("hex");
}

// Fingerprints derived by restoring the verified historical staging snapshot
// and applying only the checksum-pinned 0077 SQL. No historical check is skipped.
export const historicalInventoryFingerprints = {
  before0077: "6f869975ab4b5538f094c828524f32c3db5a6cfcc1987a29a362b044c055600f",
  after0077: "db38692058e8a3ea7dd9fee568e83317e8a11bb59c1e201fa5e1e1aa59e0201b",
};
export function assertHistoricalInventorySchema(objects: SchemaObject[], reconciliationApplied: boolean): void {
  const expected = reconciliationApplied ? historicalInventoryFingerprints.after0077 : historicalInventoryFingerprints.before0077;
  if (objects.length !== 308 || schemaFingerprint(objects) !== expected) {
    throw new Error("[migration-ledger] historical staging 0064-0066 resulting schema does not match the verified snapshot");
  }
}

export const reconciliationSchemaSql = `
  WITH objects AS (
    SELECT 'table' AS kind, c.relname::text AS key, c.relkind::text AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='catalogue_inventory_reconciliation_events'
    UNION ALL SELECT 'column', table_name||'.'||column_name,
      ordinal_position||'|'||udt_name||'|'||is_nullable||'|'||COALESCE(column_default,'<none>')
      FROM information_schema.columns WHERE table_schema='public' AND table_name='catalogue_inventory_reconciliation_events'
    UNION ALL SELECT 'constraint', c.relname||'.'||k.conname,
      pg_get_constraintdef(k.oid,true)||'|'||k.convalidated::text
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='catalogue_inventory_reconciliation_events'
    UNION ALL SELECT 'index', t.relname||'.'||i.relname,
      pg_get_indexdef(i.oid)||'|'||x.indisvalid::text||'|'||x.indisready::text
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='catalogue_inventory_reconciliation_events'
    UNION ALL SELECT 'trigger', c.relname||'.'||t.tgname,
      pg_get_triggerdef(t.oid,true)||'|'||t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('catalogue_inventory_reconciliation_events','catalogue_products') AND NOT t.tgisinternal
    UNION ALL SELECT 'function', p.proname, pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('block_live_inventory_model_change','prevent_catalogue_reconciliation_mutation')
  ) SELECT kind,key,md5(definition) AS digest FROM objects`;

export async function assertReconciliationSchema(client: Pick<pg.Client, "query">): Promise<void> {
  const result = await client.query<SchemaObject>(reconciliationSchemaSql);
  if (result.rows.length !== 26 || schemaFingerprint(result.rows) !== "9afa248edcb0372591b34f5a877fdccb6b4761a8bd41e3b5206392542215cb07") {
    throw new Error("[migration-ledger] 0077 reconciliation schema is absent or differs from the reviewed migration");
  }
}

export async function assertInventoryHistoryRepairSchema(client: Pick<pg.Client, "query">): Promise<void> {
  const result = await client.query<{ healthy: boolean }>(`
    SELECT
      to_regclass('public.inventory_history_baseline_repair_events') IS NOT NULL
      AND to_regprocedure('public.prevent_inventory_history_baseline_repair_mutation()') IS NOT NULL
      AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='inventory_history_baseline_repair_events')=10
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('id','uuid','NO'), ('tenant_id','int4','NO'), ('product_id','int4','NO'),
          ('actor_user_id','int4','NO'), ('idempotency_key','text','NO'),
          ('preview_fingerprint','text','NO'), ('reason','text','NO'), ('evidence','jsonb','NO'),
          ('finalized_at','timestamptz','NO'), ('created_at','timestamptz','NO')
        ) AS expected(column_name, udt_name, is_nullable)
        WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='public' AND c.table_name='inventory_history_baseline_repair_events'
            AND c.column_name=expected.column_name AND c.udt_name=expected.udt_name
            AND c.is_nullable=expected.is_nullable)
      )
      AND (SELECT count(*) FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype IN ('p','f','u'))=5
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype='p' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype='f' AND convalidated
          AND pg_get_constraintdef(oid,true)='FOREIGN KEY (tenant_id) REFERENCES tenants(id)')
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype='f' AND convalidated
          AND pg_get_constraintdef(oid,true)='FOREIGN KEY (actor_user_id) REFERENCES users(id)')
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype='f' AND convalidated
          AND pg_get_constraintdef(oid,true)='FOREIGN KEY (tenant_id, product_id) REFERENCES catalogue_products(tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass
          AND contype='u' AND convalidated
          AND pg_get_constraintdef(oid,true)='UNIQUE (tenant_id, idempotency_key)')
      AND (SELECT count(*) FROM pg_trigger
        WHERE tgrelid='public.inventory_history_baseline_repair_events'::regclass
          AND tgname='inventory_history_baseline_repair_events_immutable'
          AND NOT tgisinternal AND tgenabled='O')=1 AS healthy`);
  if (result.rows[0]?.healthy !== true) {
    throw new Error("[migration-ledger] 0078 inventory history repair schema is absent or differs from the reviewed migration");
  }
}
