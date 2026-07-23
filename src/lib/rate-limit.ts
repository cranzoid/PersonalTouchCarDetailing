import "server-only";

import { createHash } from "crypto";
import { lt } from "drizzle-orm";
import { headers } from "next/headers";
import { db, getPool, schema } from "@/db";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

function fingerprint(value: string): string {
  const salt = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!salt || salt.length < 32)) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  return createHash("sha256").update(`${salt ?? "ptcd-local-rate-limit"}:${value}`).digest("hex");
}

async function requestIdentity(): Promise<string> {
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Durable fixed-window rate limiter shared across app instances. Keys contain
 * only a salted hash of the request IP, never the raw address.
 */
export async function consumeRateLimit(
  scope: string,
  options: { limit: number; windowMs: number; identity?: string },
): Promise<RateLimitResult> {
  if (!/^[a-z0-9_-]{2,80}$/.test(scope)) throw new Error("Invalid rate-limit scope");
  const identity = options.identity ?? (await requestIdentity());
  const key = `${scope}:${fingerprint(identity)}`;
  const resetAt = new Date(Date.now() + options.windowMs);
  const result = await getPool().query<{ count: number; reset_at: Date }>(
    `INSERT INTO rate_limit_buckets (key, count, reset_at, updated_at)
     VALUES ($1, 1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE
         WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
         ELSE rate_limit_buckets.count + 1
       END,
       reset_at = CASE
         WHEN rate_limit_buckets.reset_at <= NOW() THEN EXCLUDED.reset_at
         ELSE rate_limit_buckets.reset_at
       END,
       updated_at = NOW()
     RETURNING count, reset_at`,
    [key, resetAt],
  );
  const row = result.rows[0];
  const count = Number(row?.count ?? options.limit + 1);
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil(((row?.reset_at ?? resetAt).getTime() - Date.now()) / 1000),
  );
  return {
    allowed: count <= options.limit,
    remaining: Math.max(0, options.limit - count),
    retryAfterSeconds,
  };
}

/** Removes expired windows so the durable limiter cannot grow without bound. */
export async function pruneExpiredRateLimits(now = new Date()): Promise<number> {
  const deleted = await db()
    .delete(schema.rateLimitBuckets)
    .where(lt(schema.rateLimitBuckets.resetAt, now))
    .returning({ key: schema.rateLimitBuckets.key });
  return deleted.length;
}
