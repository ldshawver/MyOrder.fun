import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "test") {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
const drizzleSchema = Object.fromEntries(Object.entries(schema).filter(([key]) => key.endsWith("Table"))) as Record<string, never>;
export const db: NodePgDatabase<Record<string, never>> = drizzle(pool, { schema: drizzleSchema });

export * from "./schema";
