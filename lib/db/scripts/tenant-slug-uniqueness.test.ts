import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "drizzle");
const journal = JSON.parse(
  readFileSync(resolve(root, "meta/_journal.json"), "utf8"),
);
const migration = readFileSync(
  resolve(root, "0074_tenant_slug_case_insensitive_unique.sql"),
  "utf8",
);
const adminSettingsMigration = readFileSync(
  resolve(root, "0073_admin_settings_tenant_uniqueness.sql"),
  "utf8",
);

test("tenant slug uniqueness follows the existing migration lineage", () => {
  const current = journal.entries.find((entry: { idx: number }) => entry.idx === 48);
  const appended = journal.entries.at(-1);
  assert.equal(journal.entries.find((entry: { idx: number }) => entry.idx === 47).tag, "0073_admin_settings_tenant_uniqueness");
  assert.deepEqual(current, {
    idx: 48,
    version: "7",
    when: 1790985600001,
    tag: "0074_tenant_slug_case_insensitive_unique",
    breakpoints: true,
  });
  assert.deepEqual(appended, { idx: 49, version: "7", when: 1790985600002,
    tag: "0075_catalogue_variant_attributes", breakpoints: true });
});

test("tenant slug uniqueness normalizes case without touching admin settings or rows", () => {
  assert.match(
    migration,
    /GROUP BY lower\(slug\)[\s\S]*HAVING count\(\*\) > 1/,
  );
  assert.match(
    migration,
    /ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_slug_unique/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_ci_unique_idx\s+ON tenants \(lower\(slug\)\)/,
  );
  assert.match(
    migration,
    /pg_get_indexdef\(i\.indexrelid, 1, true\) = 'lower\(slug\)'/,
  );
  assert.doesNotMatch(
    migration,
    /\b(INSERT|UPDATE|DELETE)\s+INTO?\s+(public\.)?tenants\b/i,
  );
  assert.doesNotMatch(migration, /admin_settings/i);
  assert.match(
    adminSettingsMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS admin_settings_tenant_id_unique_idx\s+ON admin_settings \(tenant_id\)/,
  );
});
