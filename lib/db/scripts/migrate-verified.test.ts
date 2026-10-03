import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { historicalStagingInventory } from "./migration-lineage.js";

const baselineUrl = process.env.LINEAGE_BASELINE_DATABASE_URL;
const migratedUrl = process.env.LINEAGE_MIGRATED_DATABASE_URL;
const enabled = Boolean(baselineUrl && migratedUrl);

test("disposable staging rehearsal preserves historical rows and existing business data", { skip: !enabled }, async () => {
  const before = new pg.Client({ connectionString: baselineUrl, ssl: false });
  const after = new pg.Client({ connectionString: migratedUrl, ssl: false });
  await before.connect();
  await after.connect();
  try {
    const ledgerSql = "SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id";
    const originalLedger = (await before.query(ledgerSql)).rows;
    const finalLedger = (await after.query(ledgerSql)).rows;
    assert.equal(originalLedger.length, 40);
    assert.equal(finalLedger.length, 46);
    assert.deepEqual(finalLedger.slice(0, 40), originalLedger);
    const journal = JSON.parse((await import("node:fs")).readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")).entries;
    for (const [offset, index] of historicalStagingInventory.forwardIndices.entries()) {
      assert.equal(finalLedger[40 + offset].created_at, String(journal[index].when));
    }
    const index = (await after.query(`SELECT i.indisunique,i.indisvalid,i.indisready
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname='admin_settings_tenant_id_unique_idx'`)).rows;
    assert.equal(index.length, 1);
    assert.deepEqual(Object.values(index[0]), [true, true, true]);
    const tables = (await before.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
    )).rows;
    let rows = 0;
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    for (const { table_name } of tables) {
      const columns = (await before.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table_name],
      )).rows.map((row) => row.column_name);
      const sql = `SELECT row_to_json(t)::text AS data FROM (SELECT ${columns.map(quote).join(",")} FROM public.${quote(table_name)}) t`;
      const [first, second] = await Promise.all([before.query<{ data: string }>(sql), after.query<{ data: string }>(sql)]);
      const digest = (records: { data: string }[]) => createHash("sha256").update(records.map((record) => record.data).sort().join("\n")).digest("hex");
      assert.equal(second.rowCount, first.rowCount, `${table_name} row count`);
      assert.equal(digest(second.rows), digest(first.rows), `${table_name} row content`);
      rows += first.rowCount ?? 0;
    }
    console.log(`preserved_original_tables=${tables.length} preserved_original_rows=${rows}`);
    await after.query("BEGIN");
    await assert.rejects(after.query("INSERT INTO admin_settings (tenant_id) SELECT tenant_id FROM admin_settings LIMIT 1"), /duplicate key/);
    await after.query("ROLLBACK");
  } finally {
    await before.end();
    await after.end();
  }
});
