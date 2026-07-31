import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Provider API credentials (Twilio, Resend) encrypted at rest so the owner can
 * rotate them from the admin UI without a deploy.
 *
 * Two rules this module exists to enforce:
 *  - Plaintext never leaves the server. The only export that a page may render
 *    is `getIntegrationStatus()`, which returns masked hints.
 *  - Credentials live in their own table, never in `business_settings` — that
 *    table is loaded wholesale into public server components by
 *    `getPublicSettings()`.
 *
 * Environment variables remain a valid source. A stored value wins; otherwise
 * we fall back to `process.env`, so an install configured the old way keeps
 * working and local development needs no encryption key at all.
 */

export const INTEGRATION_KEYS = {
  twilioAccountSid: "TWILIO_ACCOUNT_SID",
  twilioAuthToken: "TWILIO_AUTH_TOKEN",
  twilioFromNumber: "TWILIO_FROM_NUMBER",
  resendApiKey: "RESEND_API_KEY",
  emailFrom: "EMAIL_FROM",
} as const;

export type IntegrationKey = keyof typeof INTEGRATION_KEYS;

/** Values that are configuration rather than secrets — safe to show in full. */
const NON_SECRET_KEYS: ReadonlySet<IntegrationKey> = new Set(["twilioFromNumber", "emailFrom"]);

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT_VERSION = "v1";

class IntegrationConfigError extends Error {}

/**
 * Accepts base64 or hex so the key can be generated with either
 * `openssl rand -base64 32` or `openssl rand -hex 32`.
 */
function encryptionKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new IntegrationConfigError(
      "SETTINGS_ENCRYPTION_KEY is not set — credentials cannot be stored. Configure it in Azure Key Vault, or set the provider environment variables directly.",
    );
  }
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new IntegrationConfigError(
      `SETTINGS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}).`,
    );
  }
  return decoded;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    payload.toString("base64url"),
  ].join(":");
}

export function decryptSecret(stored: string): string {
  const [version, iv, authTag, payload] = stored.split(":");
  if (version !== FORMAT_VERSION || !iv || !authTag || !payload) {
    throw new IntegrationConfigError("Stored credential is not in a recognised format.");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Short process-local cache. Credentials change rarely but are read on every
 * outbound message; mutations invalidate this process immediately and other
 * workers expire within the TTL. Mirrors getPublicSettings() in settings.ts.
 */
const CACHE_TTL_MS = 60_000;
let cache: { expiresAt: number; value: Promise<Map<string, string>> } | undefined;

function loadStored(): Promise<Map<string, string>> {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    const pending = db()
      .select()
      .from(schema.integrationCredentials)
      .then((rows) => new Map(rows.map((r) => [r.key, r.valueEncrypted])));
    const guarded = pending.catch((error) => {
      if (cache?.value === guarded) cache = undefined;
      throw error;
    });
    cache = { expiresAt: now + CACHE_TTL_MS, value: guarded };
  }
  return cache.value;
}

export function invalidateIntegrationCache(): void {
  cache = undefined;
}

/**
 * Resolves a credential: stored value first, then the environment. Returns
 * undefined when neither is configured so callers can report
 * "not_configured" rather than throwing.
 */
export async function getIntegrationSecret(key: IntegrationKey): Promise<string | undefined> {
  try {
    const stored = (await loadStored()).get(key);
    if (stored) return decryptSecret(stored);
  } catch (error) {
    // A missing/rotated encryption key or an unreachable database must not take
    // messaging down when environment variables can still satisfy the request.
    // Never log the error body — it can echo ciphertext or connection strings.
    console.error(`[integrations] could not read stored credential "${key}"; falling back to environment`);
    if (!(error instanceof IntegrationConfigError)) throw error;
  }
  return process.env[INTEGRATION_KEYS[key]]?.trim() || undefined;
}

export type IntegrationFieldStatus = {
  key: IntegrationKey;
  configured: boolean;
  /** Full value for non-secret fields, last-4 hint for secrets, else null. */
  hint: string | null;
  source: "stored" | "environment" | "unset";
};

/** Masked view for the admin UI. Never returns a full secret. */
export async function getIntegrationStatus(): Promise<IntegrationFieldStatus[]> {
  const stored = await loadStored().catch(() => new Map<string, string>());
  const keys = Object.keys(INTEGRATION_KEYS) as IntegrationKey[];

  return Promise.all(
    keys.map(async (key) => {
      const hasStored = stored.has(key);
      const value = await getIntegrationSecret(key);
      if (!value) return { key, configured: false, hint: null, source: "unset" as const };
      return {
        key,
        configured: true,
        hint: NON_SECRET_KEYS.has(key) ? value : `••••${value.slice(-4)}`,
        source: hasStored ? ("stored" as const) : ("environment" as const),
      };
    }),
  );
}

export async function setIntegrationSecret(
  key: IntegrationKey,
  value: string,
  updatedByStaffId: string,
): Promise<void> {
  const valueEncrypted = encryptSecret(value);
  await db()
    .insert(schema.integrationCredentials)
    .values({ key, valueEncrypted, updatedByStaffId })
    .onConflictDoUpdate({
      target: schema.integrationCredentials.key,
      set: { valueEncrypted, updatedAt: new Date(), updatedByStaffId },
    });
  invalidateIntegrationCache();
}

export async function clearIntegrationSecret(key: IntegrationKey): Promise<void> {
  await db().delete(schema.integrationCredentials).where(eq(schema.integrationCredentials.key, key));
  invalidateIntegrationCache();
}

/** True when an encryption key is present, i.e. the admin UI can store values. */
export function canStoreCredentials(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison helper for callers that need to confirm a submitted
 * value matches what is stored without revealing it.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
