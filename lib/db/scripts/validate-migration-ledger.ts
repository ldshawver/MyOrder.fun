import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import {
  assertHistoricalStaging0047Schema,
  historicalStaging0047,
  type HistoricalStaging0047SchemaEvidence,
  legacyDev0038,
  validateAppliedLineage,
} from "./migration-lineage.js";

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
const legacyDev0038ArtifactPath = resolve(
  dbRoot,
  "migration-lineage",
  "0038_general_queue_cash_sessions.legacy-dev.sql",
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
  if (
    !existsSync(legacyDev0038ArtifactPath) ||
    fileHash(legacyDev0038ArtifactPath) !== legacyDev0038.hash
  ) {
    fail("historical DEV 0038 lineage artifact is missing or changed");
  }
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
    const {
      legacyIndices,
      appliedJournalIndices,
      historicalStaging0047Recognized,
    } = validateAppliedLineage(local, applied);

    if (legacyIndices.has(legacyDev0038.index)) {
      const reconciled = await client.query<{ healthy: boolean }>(`
        SELECT
          to_regclass('public.general_queue_cash_sessions') IS NOT NULL
          AND to_regclass('public.general_queue_cash_session_participants') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='general_queue_cash_sessions'
              AND column_name='register_box_id' AND is_nullable='YES'
          )
          AND 3 = (
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema='public' AND table_name='general_queue_cash_sessions'
              AND column_name IN ('open_idempotency_key','close_idempotency_key','discrepancy_reason')
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='admin_settings'
              AND column_name='cash_discrepancy_reason_threshold'
              AND is_nullable='NO' AND column_default='0'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='general_queue_cash_session_participants'
              AND column_name='tenant_id' AND is_nullable='NO'
          )
          AND to_regclass('public.general_queue_cash_sessions_open_location_uq') IS NOT NULL
          AND to_regclass('public.general_queue_cash_sessions_open_idempotency_uq') IS NOT NULL
          AND to_regclass('public.general_queue_cash_sessions_close_idempotency_uq') IS NOT NULL
          AND to_regclass('public.gq_participants_tenant_session_active_idx') IS NOT NULL
          AND to_regclass('public.general_queue_cash_sessions_open_register_uq') IS NULL
          AND NOT EXISTS (
            SELECT required.name
            FROM unnest(ARRAY[
              'users_tenant_id_id_unique',
              'inventory_locations_tenant_id_id_unique',
              'csr_boxes_tenant_id_id_unique',
              'general_queue_cash_sessions_tenant_id_id_unique',
              'gq_sessions_tenant_location_fk',
              'gq_sessions_tenant_register_box_fk',
              'gq_sessions_tenant_opened_by_user_fk',
              'gq_sessions_tenant_closed_by_user_fk',
              'gq_participants_tenant_session_fk',
              'gq_participants_tenant_user_fk',
              'gq_participants_tenant_joined_by_user_fk',
              'cash_ledger_tenant_gq_session_fk',
              'cash_ledger_tenant_actor_user_fk',
              'cash_ledger_tenant_location_fk'
            ]) AS required(name)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname=required.name AND convalidated
            )
          ) AS healthy
      `);
      if (reconciled.rows[0]?.healthy !== true) {
        fail(
          "historical DEV 0038 lineage lacks the required reconciled post-0039 schema",
        );
      }
      console.log(
        `[migration-ledger] HISTORICAL-LINEAGE ${legacyDev0038.tag} ` +
          `sha256=${legacyDev0038.hash} reconciled-by=${legacyDev0038.reconciliationTag}`,
      );
    }
    if (historicalStaging0047Recognized) {
      const schema = await client.query<HistoricalStaging0047SchemaEvidence>(`
        SELECT
          to_regclass('public.inventory_receipts') IS NOT NULL
            AS inventory_receipts_table,
          (
            -- Require the complete historical 0047 shape, while allowing only
            -- the additive receipt fields introduced by Phase 1 migration 0054.
            NOT EXISTS (
              (VALUES
                (1, 'id', 'int4', false),
                (2, 'tenant_id', 'int4', false),
                (3, 'product_id', 'int4', false),
                (4, 'location_id', 'int4', false),
                (5, 'quantity_received', 'numeric', false),
                (6, 'quantity_before', 'numeric', false),
                (7, 'quantity_after', 'numeric', false),
                (8, 'reason', 'text', false),
                (9, 'reference', 'text', true),
                (10, 'received_by_user_id', 'int4', false),
                (11, 'idempotency_key', 'text', false),
                (12, 'created_at', 'timestamptz', false)
              ) EXCEPT
              (SELECT ordinal_position, column_name, udt_name, is_nullable = 'YES'
                FROM information_schema.columns
              WHERE table_schema='public' AND table_name='inventory_receipts')
            )
            AND NOT EXISTS (
              (SELECT ordinal_position, column_name, udt_name, is_nullable = 'YES'
                FROM information_schema.columns
                WHERE table_schema='public' AND table_name='inventory_receipts') EXCEPT
              (VALUES
                (1, 'id', 'int4', false),
                (2, 'tenant_id', 'int4', false),
                (3, 'product_id', 'int4', false),
                (4, 'location_id', 'int4', false),
                (5, 'quantity_received', 'numeric', false),
                (6, 'quantity_before', 'numeric', false),
                (7, 'quantity_after', 'numeric', false),
                (8, 'reason', 'text', false),
                (9, 'reference', 'text', true),
                (10, 'received_by_user_id', 'int4', false),
                (11, 'idempotency_key', 'text', false),
                (12, 'created_at', 'timestamptz', false),
                -- 0054_inventory_movement_ledger additions
                (13, 'actual_unit_cost', 'numeric', true),
                (14, 'supplier_reference', 'text', true),
                (15, 'received_at', 'timestamptz', true),
                (16, 'movement_id', 'int4', true)
              )
            )
          ) AS inventory_receipts_columns,
          (
            (SELECT column_default LIKE 'nextval(%'
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='inventory_receipts' AND column_name='id')
            AND (SELECT column_default = 'now()'
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='inventory_receipts' AND column_name='created_at')
          ) AS inventory_receipts_defaults,
          (
            -- The historical constraints remain mandatory.  0054 adds the
            -- movement foreign key and no other receipt constraint is accepted.
            NOT EXISTS (
              (VALUES
                ('inventory_receipts_actor_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, received_by_user_id) REFERENCES users(tenant_id, id)'),
                ('inventory_receipts_location_id_fkey', 'f', 'FOREIGN KEY (location_id) REFERENCES inventory_locations(id)'),
                ('inventory_receipts_location_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id)'),
                ('inventory_receipts_pkey', 'p', 'PRIMARY KEY (id)'),
                ('inventory_receipts_product_id_fkey', 'f', 'FOREIGN KEY (product_id) REFERENCES catalog_items(id)'),
                ('inventory_receipts_product_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_items(tenant_id, id)'),
                ('inventory_receipts_quantity_received_check', 'c', 'CHECK (quantity_received > 0::numeric)'),
                ('inventory_receipts_received_by_user_id_fkey', 'f', 'FOREIGN KEY (received_by_user_id) REFERENCES users(id)'),
                ('inventory_receipts_tenant_id_fkey', 'f', 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)'),
                ('inventory_receipts_tenant_id_id_unique', 'u', 'UNIQUE (tenant_id, id)'),
                ('inventory_receipts_tenant_idempotency_unique', 'u', 'UNIQUE (tenant_id, idempotency_key)')
              ) EXCEPT
              (SELECT conname, contype::text, pg_get_constraintdef(oid, true)
                FROM pg_constraint WHERE conrelid='public.inventory_receipts'::regclass AND convalidated)
            )
            AND NOT EXISTS (
              (SELECT conname, contype::text, pg_get_constraintdef(oid, true)
                FROM pg_constraint WHERE conrelid='public.inventory_receipts'::regclass AND convalidated) EXCEPT
              (VALUES
                ('inventory_receipts_actor_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, received_by_user_id) REFERENCES users(tenant_id, id)'),
                ('inventory_receipts_location_id_fkey', 'f', 'FOREIGN KEY (location_id) REFERENCES inventory_locations(id)'),
                ('inventory_receipts_location_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id)'),
                ('inventory_receipts_pkey', 'p', 'PRIMARY KEY (id)'),
                ('inventory_receipts_product_id_fkey', 'f', 'FOREIGN KEY (product_id) REFERENCES catalog_items(id)'),
                ('inventory_receipts_product_tenant_fk', 'f', 'FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_items(tenant_id, id)'),
                ('inventory_receipts_quantity_received_check', 'c', 'CHECK (quantity_received > 0::numeric)'),
                ('inventory_receipts_received_by_user_id_fkey', 'f', 'FOREIGN KEY (received_by_user_id) REFERENCES users(id)'),
                ('inventory_receipts_tenant_id_fkey', 'f', 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)'),
                ('inventory_receipts_tenant_id_id_unique', 'u', 'UNIQUE (tenant_id, id)'),
                ('inventory_receipts_tenant_idempotency_unique', 'u', 'UNIQUE (tenant_id, idempotency_key)'),
                -- 0054_inventory_movement_ledger addition
                ('inventory_receipts_movement_id_fkey', 'f', 'FOREIGN KEY (movement_id) REFERENCES inventory_movements(id)')
              )
            )
          ) AS inventory_receipts_constraints,
          EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='inventory_receipts'
              AND indexname='inventory_receipts_product_location_created_idx'
              AND indexdef='CREATE INDEX inventory_receipts_product_location_created_idx ON public.inventory_receipts USING btree (tenant_id, product_id, location_id, created_at)'
          ) AS inventory_receipts_index,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='public.catalog_items'::regclass
              AND conname='catalog_items_tenant_id_id_unique'
              AND contype='u' AND convalidated
              AND pg_get_constraintdef(oid, true)='UNIQUE (tenant_id, id)'
          ) AS catalog_items_tenant_id_id_unique,
          to_regclass('public.catalog_import_preview_tokens') IS NOT NULL
            AS preview_tokens_table,
          (
            (SELECT count(*) FROM information_schema.columns
              WHERE table_schema='public' AND table_name='catalog_import_preview_tokens') = 18
            AND NOT EXISTS (
              (VALUES
                (1, 'id', 'int8', false),
                (2, 'token_sha256', 'text', false),
                (3, 'tenant_id', 'int4', false),
                (4, 'actor_id', 'int4', false),
                (5, 'workbook_sha256', 'text', false),
                (6, 'preview_request_id', 'text', false),
                (7, 'expected_inserted', 'int4', false),
                (8, 'expected_updated', 'int4', false),
                (9, 'expected_visible', 'int4', false),
                (10, 'expected_held', 'int4', false),
                (11, 'expected_duplicates', 'int4', false),
                (12, 'expected_errors', 'int4', false),
                (13, 'source_state_sha256', 'text', false),
                (14, 'issued_at', 'timestamptz', false),
                (15, 'expires_at', 'timestamptz', false),
                (16, 'consumed_at', 'timestamptz', true),
                (17, 'confirmation_request_id', 'text', true),
                (18, 'created_at', 'timestamptz', false)
              ) EXCEPT
              (SELECT ordinal_position, column_name, udt_name, is_nullable = 'YES'
                FROM information_schema.columns
                WHERE table_schema='public' AND table_name='catalog_import_preview_tokens')
            )
            AND NOT EXISTS (
              (SELECT ordinal_position, column_name, udt_name, is_nullable = 'YES'
                FROM information_schema.columns
                WHERE table_schema='public' AND table_name='catalog_import_preview_tokens') EXCEPT
              (VALUES
                (1, 'id', 'int8', false),
                (2, 'token_sha256', 'text', false),
                (3, 'tenant_id', 'int4', false),
                (4, 'actor_id', 'int4', false),
                (5, 'workbook_sha256', 'text', false),
                (6, 'preview_request_id', 'text', false),
                (7, 'expected_inserted', 'int4', false),
                (8, 'expected_updated', 'int4', false),
                (9, 'expected_visible', 'int4', false),
                (10, 'expected_held', 'int4', false),
                (11, 'expected_duplicates', 'int4', false),
                (12, 'expected_errors', 'int4', false),
                (13, 'source_state_sha256', 'text', false),
                (14, 'issued_at', 'timestamptz', false),
                (15, 'expires_at', 'timestamptz', false),
                (16, 'consumed_at', 'timestamptz', true),
                (17, 'confirmation_request_id', 'text', true),
                (18, 'created_at', 'timestamptz', false)
              )
            )
          ) AS preview_tokens_columns,
          (
            (SELECT column_default LIKE 'nextval(%'
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='catalog_import_preview_tokens' AND column_name='id')
            AND (SELECT column_default = 'now()'
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='catalog_import_preview_tokens' AND column_name='issued_at')
            AND (SELECT column_default = 'now()'
              FROM information_schema.columns
              WHERE table_schema='public' AND table_name='catalog_import_preview_tokens' AND column_name='created_at')
          ) AS preview_tokens_defaults,
          (
            (SELECT count(*) FROM pg_constraint
              WHERE conrelid='public.catalog_import_preview_tokens'::regclass) = 4
            AND NOT EXISTS (
              (VALUES
                ('catalog_import_preview_tokens_actor_id_fkey', 'f', 'FOREIGN KEY (actor_id) REFERENCES users(id)'),
                ('catalog_import_preview_tokens_pkey', 'p', 'PRIMARY KEY (id)'),
                ('catalog_import_preview_tokens_tenant_id_fkey', 'f', 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)'),
                ('catalog_import_preview_tokens_token_sha256_key', 'u', 'UNIQUE (token_sha256)')
              ) EXCEPT
              (SELECT conname, contype::text, pg_get_constraintdef(oid, true)
                FROM pg_constraint WHERE conrelid='public.catalog_import_preview_tokens'::regclass AND convalidated)
            )
          ) AS preview_tokens_constraints,
          (
            (SELECT count(*) FROM pg_indexes
              WHERE schemaname='public' AND tablename='catalog_import_preview_tokens') = 4
            AND EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname='public' AND tablename='catalog_import_preview_tokens'
                AND indexname='catalog_import_preview_tokens_expiry_idx'
                AND indexdef='CREATE INDEX catalog_import_preview_tokens_expiry_idx ON public.catalog_import_preview_tokens USING btree (expires_at) WHERE (consumed_at IS NULL)'
            )
            AND EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname='public' AND tablename='catalog_import_preview_tokens'
                AND indexname='catalog_import_preview_tokens_tenant_actor_idx'
                AND indexdef='CREATE INDEX catalog_import_preview_tokens_tenant_actor_idx ON public.catalog_import_preview_tokens USING btree (tenant_id, actor_id, expires_at) WHERE (consumed_at IS NULL)'
            )
          ) AS preview_tokens_indexes
      `);
      assertHistoricalStaging0047Schema(
        schema.rows[0] ?? {
          inventory_receipts_table: false,
          inventory_receipts_columns: false,
          inventory_receipts_defaults: false,
          inventory_receipts_constraints: false,
          inventory_receipts_index: false,
          catalog_items_tenant_id_id_unique: false,
          preview_tokens_table: false,
          preview_tokens_columns: false,
          preview_tokens_defaults: false,
          preview_tokens_constraints: false,
          preview_tokens_indexes: false,
        },
      );
      console.log(
        "migration_lineage=historical_staging_0047_reconciled " +
          `historical_hash=${historicalStaging0047.historicalHash} ` +
          `canonical_tag=${historicalStaging0047.canonicalTag} ` +
          "schema_verified=true ledger_mutated=false",
      );
    }
    await client.query("COMMIT");

    for (const [index, migration] of local.entries()) {
      const state = appliedJournalIndices.has(index) ? "APPLIED" : "PENDING";
      const lineage = legacyIndices.has(index)
        ? index === historicalStaging0047.index
          ? ` historical-sha256=${historicalStaging0047.historicalHash}`
          : ` historical-sha256=${legacyDev0038.hash}`
        : "";
      console.log(
        `[migration-ledger] ${state} ${migration.tag} sha256=${migration.hash}${lineage}`,
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
