import pg from "pg";

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const parsed = new URL(url);
const maskedHost = parsed.hostname;
const maskedDb = parsed.pathname.replace(/^\//, "");
console.log(`\n[check-db] Connecting to host=${maskedHost} db=${maskedDb}`);

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });

async function main() {
  const client = await pool.connect();
  try {
    const ping = await client.query("SELECT 1 AS ping");
    console.log(`[check-db] SELECT 1: ${JSON.stringify(ping.rows[0])}`);

    const info = await client.query(
      "SELECT current_database() AS db, current_user AS \"user\", version() AS ver"
    );
    const row = info.rows[0] as { db: string; user: string; ver: string };
    console.log(`[check-db] database : ${row.db}`);
    console.log(`[check-db] user     : ${row.user}`);
    console.log(`[check-db] pg ver   : ${row.ver.split(" ").slice(0, 2).join(" ")}`);

    const schemas = await client.query(
      "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
    );
    console.log(
      `[check-db] schemas  : ${schemas.rows.map((r: { schema_name: string }) => r.schema_name).join(", ")}`
    );

    const perms = await client.query(`
      SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
             has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_db
    `);
    const p = perms.rows[0] as { can_create: boolean; can_create_db: boolean };
    console.log(`[check-db] schema CREATE priv : ${p.can_create}`);
    console.log(`[check-db] db     CREATE priv : ${p.can_create_db}`);

    console.log("[check-db] OK — database is reachable and healthy\n");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[check-db] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
