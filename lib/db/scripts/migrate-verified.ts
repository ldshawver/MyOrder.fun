import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { historicalStagingInventory, validateAppliedLineage } from "./migration-lineage.js";

const migrationsFolder = resolve(import.meta.dirname, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"));
const local = journal.entries.map((entry: { idx: number; tag: string; when: number }) => ({
  ...entry,
  hash: createHash("sha256").update(readFileSync(resolve(migrationsFolder, `${entry.tag}.sql`))).digest("hex"),
}));
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  ...(process.env.DB_SSL === "false" ? { ssl: false } : {}),
});

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await client.connect();
  let locked = false;
  try {
    // Session lock spans both the separate read-only validator process and the
    // transactional Drizzle migration. Every deployment migrator uses this key.
    await client.query("SET statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_lock(1299805539, 20261003)");
    locked = true;
    await client.query("SET statement_timeout = 0");
    console.log("[migration] exclusive deployment lock acquired");
    execFileSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "validate-migration-ledger.ts")], {
      cwd: resolve(import.meta.dirname, ".."), env: process.env, stdio: "inherit",
    });

    const applied = (await client.query<{ id: number; hash: string; created_at: string }>(
      "SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
    )).rows;
    const result = validateAppliedLineage(local, applied);
    const pendingIndices = local.map((_: unknown, index: number) => index)
      .filter((index: number) => !result.appliedJournalIndices.has(index));
    if (result.historicalStagingInventoryRecognized) {
      const forward = historicalStagingInventory.forwardIndices;
      const completed = applied.length - 40;
      if (JSON.stringify(pendingIndices) !== JSON.stringify(forward.slice(completed))) {
        throw new Error("[migration] unexpected historical staging pending sequence");
      }
    } else {
      const first = pendingIndices[0] ?? local.length;
      if (pendingIndices.some((index: number, offset: number) => index !== first + offset)) {
        throw new Error("[migration] non-staging lineage has a migration gap");
      }
    }
    const migrations = readMigrationFiles({ migrationsFolder });
    if (migrations.length !== local.length) throw new Error("[migration] journal and SQL file counts differ");
    console.log(`[migration] pending=${pendingIndices.map((index: number) => local[index].tag).join(",") || "none"}`);
    if (pendingIndices.length) {
      const db = drizzle(client);
      await db.dialect.migrate(pendingIndices.map((index: number) => migrations[index]), db.session, {});
    }
    const after = (await client.query<{ id: number; hash: string; created_at: string }>(
      "SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
    )).rows;
    validateAppliedLineage(local, after);
    if (JSON.stringify(after.slice(0, applied.length)) !== JSON.stringify(applied) ||
        after.length !== applied.length + pendingIndices.length) {
      throw new Error("[migration] ledger changed unexpectedly");
    }
    console.log(`[migration] success ledger=${after.length} applied=${pendingIndices.length}`);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(1299805539, 20261003)");
      console.log("[migration] exclusive deployment lock released");
    }
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "[migration] failed");
  process.exitCode = 1;
});
