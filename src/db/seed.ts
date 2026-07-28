import { runSeed } from "./seed-runner";

runSeed().catch((err) => {
  console.error(err);
  process.exit(1);
});
