import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_integration_owner",
    name: "Integration Owner",
    email: "integration-owner@example.com",
    role: "owner" as const,
  },
  requireStaff: vi.fn(),
}));
auth.requireStaff.mockResolvedValue(auth.actor);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: auth.requireStaff,
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { getIntegrationSecret, invalidateIntegrationCache } from "../src/lib/integrations";
import { saveIntegrationCredentialsAction } from "../src/app/admin/(app)/settings/integrations/actions";

const KEY = randomBytes(32).toString("base64");
const VALID_SID = `AC${"a1b2c3d4".repeat(4)}`;
const VALID_TOKEN = "f".repeat(32);

async function resetDb() {
  await db().execute(sql`TRUNCATE integration_credentials, staff_users, audit_log CASCADE`);
  await db().insert(schema.staffUsers).values({
    id: auth.actor.id,
    name: auth.actor.name,
    email: auth.actor.email,
    passwordHash: "not-used-in-tests",
    role: auth.actor.role,
    active: true,
  });
  auth.requireStaff.mockClear();
  auth.requireStaff.mockResolvedValue(auth.actor);
  invalidateIntegrationCache();
}

describe("saveIntegrationCredentialsAction validation", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    await resetDb();
  });

  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
  });

  // The original mistake: a Resend key pasted into the Twilio auth token
  // field. Twilio answers that with an opaque 401, so it has to be caught here.
  it("rejects a Resend API key in the Twilio auth token field", async () => {
    const res = await saveIntegrationCredentialsAction({
      twilioAuthToken: "re_abc123_notatwiliotoken",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/32 hex characters/);
    // Nothing partially written.
    expect(await getIntegrationSecret("twilioAuthToken")).toBeUndefined();
  });

  it("rejects an API Key SID in place of the Account SID", async () => {
    const res = await saveIntegrationCredentialsAction({
      twilioAccountSid: `SK${"a1b2c3d4".repeat(4)}`,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/SK/);
  });

  it("rejects a swapped SID and token pair", async () => {
    const res = await saveIntegrationCredentialsAction({
      twilioAccountSid: VALID_TOKEN,
      twilioAuthToken: VALID_SID,
    });

    expect(res.ok).toBe(false);
  });

  it("rejects a from number that is not E.164", async () => {
    const res = await saveIntegrationCredentialsAction({ twilioFromNumber: "+1 905 555 0143" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/E\.164/);
  });

  it("never echoes the submitted value back in the error", async () => {
    const secret = "re_supersecret_value_9999";
    const res = await saveIntegrationCredentialsAction({ twilioAuthToken: secret });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).not.toContain(secret);
    expect(res.error).not.toContain("9999");
  });

  it("rejects the whole submission rather than saving the good fields", async () => {
    const res = await saveIntegrationCredentialsAction({
      twilioAccountSid: VALID_SID,
      twilioAuthToken: "definitely-not-hex",
    });

    expect(res.ok).toBe(false);
    // A partial save is what makes a 401 hard to diagnose.
    expect(await getIntegrationSecret("twilioAccountSid")).toBeUndefined();
  });

  it("accepts a well-formed Twilio credential set", async () => {
    const res = await saveIntegrationCredentialsAction({
      twilioAccountSid: VALID_SID,
      twilioAuthToken: VALID_TOKEN,
      twilioFromNumber: "+19055550143",
    });

    expect(res.ok).toBe(true);
    expect(await getIntegrationSecret("twilioAccountSid")).toBe(VALID_SID);
    expect(await getIntegrationSecret("twilioAuthToken")).toBe(VALID_TOKEN);
    expect(await getIntegrationSecret("twilioFromNumber")).toBe("+19055550143");
  });

  it("treats blank fields as leave-as-is", async () => {
    await saveIntegrationCredentialsAction({
      twilioAccountSid: VALID_SID,
      twilioAuthToken: VALID_TOKEN,
    });

    const res = await saveIntegrationCredentialsAction({ twilioFromNumber: "+19055550143" });

    expect(res.ok).toBe(true);
    expect(await getIntegrationSecret("twilioAuthToken")).toBe(VALID_TOKEN);
  });
});
