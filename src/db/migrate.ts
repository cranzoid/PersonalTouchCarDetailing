import { runMigrations } from "./migration-runner";

/**
 * Applies committed SQL migrations from ./drizzle.
 * Usage: npm run db:migrate (honours DATABASE_URL; pass TEST=1 to target TEST_DATABASE_URL)
 */
runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});
