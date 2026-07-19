import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Single shared pool. In dev, Next.js hot-reload re-evaluates modules, so the
 * pool is cached on globalThis to avoid connection exhaustion.
 */
const globalForDb = globalThis as unknown as {
  __ptcdPool?: Pool;
};

export function getPool(): Pool {
  if (!globalForDb.__ptcdPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    globalForDb.__ptcdPool = new Pool({ connectionString, max: 10 });
  }
  return globalForDb.__ptcdPool;
}

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | undefined;
export function db(): Db {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

export { schema };
