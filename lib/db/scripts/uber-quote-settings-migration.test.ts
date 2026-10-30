import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const drizzle = resolve(import.meta.dirname, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(drizzle, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
const sql = readFileSync(resolve(drizzle, "0083_uber_quote_authoritative_settings.sql"), "utf8");

test("0083 follows pickup scheduling and adds only nullable fail-closed quote settings", () => {
  assert.deepEqual(journal.entries.slice(-2).map(entry => [entry.idx, entry.tag]), [
    [56, "0082_location_pickup_scheduling"],
    [57, "0083_uber_quote_authoritative_settings"],
  ]);
  for (const column of ["pickup_latitude", "pickup_longitude", "external_store_id", "pickup_window_minutes", "dropoff_window_minutes"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.doesNotMatch(sql, /UPDATE\s+"uber_direct_settings"/i);
  assert.doesNotMatch(sql, /DEFAULT\s+/i);
  assert.match(sql, /FOREIGN KEY \("tenant_id", "pickup_location_id"\)/);
});
