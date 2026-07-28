import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadEnv } from "../lib/load-env";

loadEnv();

/** Applies committed SQL migrations from ./drizzle. */
export async function runMigrations() {
  const url = process.env.TEST === "1" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (or TEST_DATABASE_URL with TEST=1) is not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log(`Migrations applied to ${url.replace(/:[^@/]+@/, ":***@")}`);
  } finally {
    await pool.end();
  }
}
