import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl =
  process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "NEON_DATABASE_URL or DATABASE_URL must be set.",
  );
}

// Fail fast when Neon/Render cannot establish a connection. Without these
// limits, the first health check can remain pending forever and the Discord
// worker never reaches client.login().
export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
