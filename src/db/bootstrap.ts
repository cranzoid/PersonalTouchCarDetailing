import { runMigrations } from "./migration-runner";
import { runSeed } from "./seed-runner";

export async function bootstrapDatabase() {
  console.log("Applying database migrations before accepting traffic.");
  await runMigrations();
  await runSeed();
}
