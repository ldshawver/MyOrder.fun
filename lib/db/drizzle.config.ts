import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Docker-internal Postgres (the `db` container) does not run with SSL.
// Set DB_SSL=false in the migrate container environment to skip SSL negotiation.
// Leave unset (or set to "true") for managed Postgres services that require SSL.
const sslDisabled = process.env.DB_SSL === "false";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
    ...(sslDisabled ? { ssl: false } : {}),
  },
});
