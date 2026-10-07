import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0076_tenant_woo_store_url_no_default.sql"), "utf8");

test("Woo URL has no merchant-specific default and migration 0076 is append-only", () => {
  assert.deepEqual(journal.entries.at(-1), {
    idx: 50,
    version: "7",
    when: 1791358517378,
    tag: "0076_tenant_woo_store_url_no_default",
    breakpoints: true,
  });
  assert.match(migration, /ALTER COLUMN wc_store_url DROP DEFAULT/);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE|INSERT)\b/i);
  const settings = readFileSync(resolve(root, "../src/schema/settings.ts"), "utf8");
  assert.match(settings, /wcStoreUrl: text\("wc_store_url"\),/);
  assert.doesNotMatch(settings, /https:\/\/(?:store\.)?lucifercruz\.com/);
});
