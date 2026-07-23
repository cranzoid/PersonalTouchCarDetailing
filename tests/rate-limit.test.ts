import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { consumeRateLimit, pruneExpiredRateLimits } from "../src/lib/rate-limit";

describe("durable rate limiting", () => {
  beforeEach(async () => {
    await db().execute(sql`TRUNCATE rate_limit_buckets`);
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("enforces a shared fixed window without storing the raw identity", async () => {
    const options = { limit: 2, windowMs: 60_000, identity: "203.0.113.42" };
    expect((await consumeRateLimit("test-login", options)).allowed).toBe(true);
    expect((await consumeRateLimit("test-login", options)).allowed).toBe(true);
    const blocked = await consumeRateLimit("test-login", options);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    const [bucket] = await db().select().from(schema.rateLimitBuckets);
    expect(bucket.count).toBe(3);
    expect(bucket.key).not.toContain(options.identity);
  });

  it("starts a fresh count after the stored window expires", async () => {
    const options = { limit: 1, windowMs: 60_000, identity: "198.51.100.11" };
    expect((await consumeRateLimit("test-quote", options)).allowed).toBe(true);
    expect((await consumeRateLimit("test-quote", options)).allowed).toBe(false);
    await db().execute(sql`UPDATE rate_limit_buckets SET reset_at = NOW() - INTERVAL '1 second'`);

    const fresh = await consumeRateLimit("test-quote", options);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(0);
  });

  it("prunes expired buckets but keeps active windows", async () => {
    await db().insert(schema.rateLimitBuckets).values([
      { key: "expired", count: 4, resetAt: new Date(Date.now() - 1_000) },
      { key: "active", count: 1, resetAt: new Date(Date.now() + 60_000) },
    ]);

    expect(await pruneExpiredRateLimits()).toBe(1);
    const rows = await db().select().from(schema.rateLimitBuckets);
    expect(rows.map((row) => row.key)).toEqual(["active"]);
  });
});
