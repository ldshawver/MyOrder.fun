import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface HistoricalEntry {
  tag: string;
  sha256: string;
  classification:
    | "historical_unjournaled"
    | "data_repair_excluded"
    | "destructive_excluded";
  reason: string;
}

interface HistoricalInventory {
  version: number;
  files: HistoricalEntry[];
}

interface LocalMigration extends JournalEntry {
  hash: string;
}

interface AppliedMigration {
  id: number;
  hash: string;
  created_at: string;
}

const dbRoot = resolve(import.meta.dirname, "..");
const migrationsDir = resolve(dbRoot, "drizzle");
const journalPath = resolve(migrationsDir, "meta", "_journal.json");
const historicalPath = resolve(
  migrationsDir,
  "meta",
  "_historical_migrations.json",
);

function fail(message: string): never {
  throw new Error(`[migration-ledger] ${message}`);
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function numericPrefix(tag: string): string {
  return tag.slice(0, 4);
}

function loadAndValidateInventory(journalTags: Set<string>): HistoricalEntry[] {
  const inventory = JSON.parse(
    readFileSync(historicalPath, "utf8"),
  ) as HistoricalInventory;
  if (inventory.version !== 1 || !Array.isArray(inventory.files)) {
    fail("unsupported historical migration inventory format");
  }

  const diskTags = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .map((name) => name.slice(0, -4))
    .sort();
  const historicalTags = new Set<string>();

  for (const entry of inventory.files) {
    if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) {
      fail(`historical inventory contains invalid tag ${entry.tag}`);
    }
    if (historicalTags.has(entry.tag)) {
      fail(`historical inventory contains duplicate tag ${entry.tag}`);
    }
    if (journalTags.has(entry.tag)) {
      fail(`${entry.tag} is both journaled and classified as historical`);
    }
    if (!entry.reason.trim()) {
      fail(`historical inventory entry ${entry.tag} has no reason`);
    }

    const sqlPath = resolve(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      fail(`classified historical migration file is missing: ${entry.tag}.sql`);
    }
    const actualHash = fileHash(sqlPath);
    if (actualHash !== entry.sha256) {
      fail(`classified historical migration changed: ${entry.tag}.sql`);
    }
    historicalTags.add(entry.tag);
  }

  const classifiedTags = new Set([...journalTags, ...historicalTags]);
  const unclassified = diskTags.filter((tag) => !classifiedTags.has(tag));
  const missing = [...classifiedTags].filter((tag) => !diskTags.includes(tag));
  if (unclassified.length > 0) {
    fail(`unclassified SQL migration files: ${unclassified.join(", ")}`);
  }
  if (missing.length > 0) {
    fail(
      `inventory references missing SQL migration files: ${missing.join(", ")}`,
    );
  }

  const byNumber = new Map<string, string[]>();
  for (const tag of diskTags) {
    const prefix = numericPrefix(tag);
    byNumber.set(prefix, [...(byNumber.get(prefix) ?? []), tag]);
  }
  const duplicates = [...byNumber.entries()].filter(
    ([, tags]) => tags.length > 1,
  );
  for (const [prefix, tags] of duplicates) {
    const executable = tags.filter((tag) => journalTags.has(tag));
    if (executable.length > 1) {
      fail(
        `duplicate executable migration number ${prefix}: ${executable.join(", ")}`,
      );
    }
    console.log(
      `[migration-ledger] classified historical duplicate ${prefix}: ${tags.join(", ")}`,
    );
  }

  console.log(
    `[migration-ledger] inventory valid: ${diskTags.length} SQL files ` +
      `(${journalTags.size} executable, ${historicalTags.size} historical/excluded)`,
  );
  return inventory.files;
}

function loadJournal(): LocalMigration[] {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (journal.version !== "7" || journal.dialect !== "postgresql") {
    fail(`unsupported journal format ${journal.version}/${journal.dialect}`);
  }

  const tags = new Set<string>();
  const numericPrefixes = new Set<string>();
  let previousWhen = -1;

  const local = journal.entries.map((entry, position) => {
    if (entry.idx !== position) {
      fail(`entry ${entry.tag} has idx ${entry.idx}; expected ${position}`);
    }
    if (!Number.isSafeInteger(entry.when) || entry.when <= previousWhen) {
      fail(`entry ${entry.tag} has a non-increasing timestamp`);
    }
    if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) {
      fail(`entry ${entry.tag} has an invalid tag`);
    }
    if (tags.has(entry.tag)) {
      fail(`duplicate journal tag ${entry.tag}`);
    }

    const prefix = numericPrefix(entry.tag);
    if (numericPrefixes.has(prefix)) {
      fail(`duplicate executable migration number ${prefix}`);
    }

    const sqlPath = resolve(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      fail(`journaled migration file is missing: ${entry.tag}.sql`);
    }

    previousWhen = entry.when;
    tags.add(entry.tag);
    numericPrefixes.add(prefix);
    return { ...entry, hash: fileHash(sqlPath) };
  });

  loadAndValidateInventory(tags);
  return local;
}

async function validateAppliedPrefix(local: LocalMigration[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail("DATABASE_URL is not set");
  }

  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ...(process.env.DB_SSL === "false" ? { ssl: false } : {}),
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");

    const requiredBaselineTables = [
      "users",
      "tenants",
      "orders",
      "lab_tech_shifts",
      "print_jobs",
    ];
    const baseline = await client.query<{
      name: string;
      relation: string | null;
    }>(
      "SELECT name, to_regclass('public.' || name)::text AS relation FROM unnest($1::text[]) AS name",
      [requiredBaselineTables],
    );
    const missingBaseline = baseline.rows
      .filter((row) => !row.relation)
      .map((row) => row.name);
    if (missingBaseline.length > 0) {
      fail(
        `database is not a supported schema snapshot; missing baseline tables: ${missingBaseline.join(", ")}`,
      );
    }

    const table = await client.query<{ migration_table: string | null }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migration_table",
    );
    const applied = table.rows[0]?.migration_table
      ? (
          await client.query<AppliedMigration>(
            "SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
          )
        ).rows
      : [];
    await client.query("COMMIT");

    if (applied.length > local.length) {
      fail(
        `database has ${applied.length} migrations but the journal has only ${local.length}`,
      );
    }

    for (const [index, row] of applied.entries()) {
      const expected = local[index];
      if (
        row.hash !== expected.hash ||
        row.created_at !== String(expected.when)
      ) {
        fail(
          `database row ${index + 1} does not match journal entry ${expected.tag}; refusing to migrate`,
        );
      }
    }

    for (const [index, migration] of local.entries()) {
      const state = index < applied.length ? "APPLIED" : "PENDING";
      console.log(
        `[migration-ledger] ${state} ${migration.tag} sha256=${migration.hash}`,
      );
    }
    console.log(
      `[migration-ledger] production prefix preserved: ${applied.length}/${local.length}`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const local = loadJournal();
  console.log(
    `[migration-ledger] journal valid: ${local.length} uniquely numbered executable entries`,
  );

  if (process.argv.includes("--journal-only")) {
    for (const migration of local) {
      console.log(
        `[migration-ledger] JOURNALED ${migration.tag} sha256=${migration.hash}`,
      );
    }
    return;
  }

  await validateAppliedPrefix(local);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "[migration-ledger] validation failed",
  );
  process.exit(1);
});
