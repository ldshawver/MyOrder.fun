#!/usr/bin/env node
/**
 * Alavont — Promote a user to global_admin.
 * Works by email OR by numeric user ID (whichever you have).
 *
 * Usage:
 *   node scripts/promote-admin.mjs admin@example.com
 *   node scripts/promote-admin.mjs 42          ← if you only have the ID
 *
 * On VPS (inside Docker):
 *   docker compose exec api node scripts/promote-admin.mjs admin@example.com
 *
 * How to find your user ID:
 *   docker compose exec db psql -U alavont alavont \
 *     -c "SELECT id, email, clerk_id, role, created_at FROM users ORDER BY created_at DESC LIMIT 5;"
 */

import pg from "pg";

const identifier = process.argv[2];
if (!identifier) {
  console.error("Usage: node scripts/promote-admin.mjs <email|user-id>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();

  // Determine if identifier is a numeric ID or an email
  const isId = /^\d+$/.test(identifier);
  const field = isId ? "id" : "email";
  const value = isId ? parseInt(identifier, 10) : identifier;

  const { rows } = await client.query(
    `UPDATE users SET role = 'global_admin' WHERE ${field} = $1 RETURNING id, email, clerk_id, role`,
    [value]
  );

  if (rows.length === 0) {
    // Show existing users to help them find the right one
    const { rows: all } = await client.query(
      `SELECT id, email, clerk_id, role, created_at FROM users ORDER BY created_at DESC LIMIT 10`
    );
    console.error(`\nNo user found with ${field}: ${identifier}`);
    console.error("\nExisting users:");
    console.table(all);
    console.error("\nTip: The user must sign in at least once before you can promote them.");
    process.exit(1);
  }

  console.log(`\n✓ Promoted to global_admin:`);
  console.log(`  ID:       ${rows[0].id}`);
  console.log(`  Email:    ${rows[0].email || "(not stored)"}`);
  console.log(`  Clerk ID: ${rows[0].clerk_id}`);
  console.log(`  Role:     ${rows[0].role}`);
  console.log(`\n  Sign out and back in to see admin controls.\n`);
} finally {
  await client.end();
}
