import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { db, getPool } from "../src/db";
import {
  clearIntegrationSecret,
  getIntegrationSecret,
  getIntegrationStatus,
  invalidateIntegrationCache,
  setIntegrationSecret,
} from "../src/lib/integrations";

const KEY = randomBytes(32).toString("base64");

async function resetDb() {
  await db().execute(sql`TRUNCATE integration_credentials CASCADE`);
  invalidateIntegrationCache();
}

function status(rows: Awaited<ReturnType<typeof getIntegrationStatus>>, key: string) {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no status for ${key}`);
  return row;
}

describe("integration credential status", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    await resetDb();
  });

  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("reports a stored secret as set, masked, and removable", async () => {
    await setIntegrationSecret("twilioAuthToken", "supersecrettoken1234", "usr_test_owner");

    const row = status(await getIntegrationStatus(), "twilioAuthToken");
    expect(row.configured).toBe(true);
    expect(row.source).toBe("stored");
    expect(row.hint).toBe("••••1234");
    // The masked hint is all the UI ever receives.
    expect(row.hint).not.toContain("supersecret");
  });

  // The bug this file exists for: a removal that succeeded in the database
  // still rendered as "Set", so it looked like Remove did nothing.
  it("reports a cleared secret as unset immediately, not from a stale cache", async () => {
    await setIntegrationSecret("twilioAuthToken", "supersecrettoken1234", "usr_test_owner");
    // Warm the read-through cache the way a page render would.
    expect(await getIntegrationSecret("twilioAuthToken")).toBe("supersecrettoken1234");

    await clearIntegrationSecret("twilioAuthToken");

    const row = status(await getIntegrationStatus(), "twilioAuthToken");
    expect(row.configured).toBe(false);
    expect(row.source).toBe("unset");
  });

  it("reports a newly stored secret without waiting for the cache to expire", async () => {
    expect(status(await getIntegrationStatus(), "twilioAccountSid").source).toBe("unset");

    await setIntegrationSecret("twilioAccountSid", "ACtestaccountsid0001", "usr_test_owner");

    expect(status(await getIntegrationStatus(), "twilioAccountSid").source).toBe("stored");
  });

  it("overwrites a value entered into the wrong field", async () => {
    await setIntegrationSecret("twilioAuthToken", "re_a_resend_key_9999", "usr_test_owner");
    await setIntegrationSecret("twilioAuthToken", "the_real_twilio_1111", "usr_test_owner");

    expect(await getIntegrationSecret("twilioAuthToken")).toBe("the_real_twilio_1111");
    expect(status(await getIntegrationStatus(), "twilioAuthToken").hint).toBe("••••1111");
  });

  it("shows a non-secret field in full so the owner can verify it", async () => {
    await setIntegrationSecret("twilioFromNumber", "+19055550143", "usr_test_owner");

    const row = status(await getIntegrationStatus(), "twilioFromNumber");
    expect(row.hint).toBe("+19055550143");
  });

  it("marks a row it cannot decrypt as unreadable so it stays removable", async () => {
    await setIntegrationSecret("twilioAuthToken", "supersecrettoken1234", "usr_test_owner");
    // Rotating the key is what makes existing ciphertext unopenable.
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    invalidateIntegrationCache();

    const row = status(await getIntegrationStatus(), "twilioAuthToken");
    expect(row.configured).toBe(false);
    expect(row.source).toBe("unreadable");
    // Must not throw — an unreadable row used to take the whole page down.
    expect(await getIntegrationSecret("twilioAuthToken")).toBeUndefined();

    await clearIntegrationSecret("twilioAuthToken");
    expect(status(await getIntegrationStatus(), "twilioAuthToken").source).toBe("unset");
  });

  it("falls back to the environment only when nothing is stored", async () => {
    process.env.TWILIO_AUTH_TOKEN = "env_token_value_5678";

    expect(status(await getIntegrationStatus(), "twilioAuthToken").source).toBe("environment");

    await setIntegrationSecret("twilioAuthToken", "stored_wins_here_4321", "usr_test_owner");
    const row = status(await getIntegrationStatus(), "twilioAuthToken");
    expect(row.source).toBe("stored");
    expect(row.hint).toBe("••••4321");
  });
});
