import { loadEnv } from "../src/lib/load-env";

loadEnv();

// All DB access in tests targets the dedicated test database.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
process.env.DATABASE_URL = testUrl;
