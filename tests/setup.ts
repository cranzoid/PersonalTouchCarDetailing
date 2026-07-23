import { loadEnv } from "../src/lib/load-env";

loadEnv();

// All DB access in tests targets the dedicated test database.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
const testDatabase = new URL(testUrl).pathname.replace(/^\//, "");
if (testDatabase !== "ptcd_test") {
  throw new Error(
    `Refusing to run destructive integration tests against database "${testDatabase}"; expected "ptcd_test"`,
  );
}
process.env.DATABASE_URL = testUrl;
