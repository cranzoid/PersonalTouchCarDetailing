"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import {
  canStoreCredentials,
  clearIntegrationSecret,
  setIntegrationSecret,
  type IntegrationKey,
} from "@/lib/integrations";
import { sendMessage } from "@/lib/messaging";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * Twilio answers a malformed credential pair with a bare 401 that names
 * neither field, so the shapes are checked here instead. These formats are
 * stable and documented: Account SID is "AC" + 32 hex, auth token is 32 hex,
 * and this integration authenticates with the Account SID itself, so an API
 * Key SID ("SK…") cannot stand in for it.
 */
const TWILIO_ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const TWILIO_AUTH_TOKEN = /^[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Blank means "leave as-is", so every rule has to pass an empty value. */
const optional = (max: number) => z.string().trim().max(max).optional();
const shaped = (max: number, ok: RegExp, message: string) =>
  optional(max).refine((v) => !v || ok.test(v), { message });

/**
 * Every field is optional and blank means "leave as-is". The form never
 * receives existing secrets, so submitting it must not be able to wipe them.
 */
const credentialsInput = z.object({
  twilioAccountSid: shaped(
    200,
    TWILIO_ACCOUNT_SID,
    'Twilio Account SID must be "AC" followed by 32 hex characters — copy it from the Twilio Console dashboard. An API Key SID starting with "SK" will not work here.',
  ),
  twilioAuthToken: shaped(
    200,
    TWILIO_AUTH_TOKEN,
    "Twilio Auth Token must be 32 hex characters — it sits next to the Account SID on the Twilio Console dashboard. This is not the Resend API key and not the Account SID.",
  ),
  twilioFromNumber: shaped(
    30,
    E164,
    "From number must be in E.164 format with no spaces or dashes, e.g. +19055550143.",
  ),
  resendApiKey: shaped(200, /^re_/, 'Resend API key must start with "re_".'),
  emailFrom: optional(200),
});

const CREDENTIAL_KEYS = [
  "twilioAccountSid",
  "twilioAuthToken",
  "twilioFromNumber",
  "resendApiKey",
  "emailFrom",
] as const satisfies readonly IntegrationKey[];

export async function saveIntegrationCredentialsAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_integrations");
    if (!canStoreCredentials()) {
      return {
        ok: false,
        error:
          "SETTINGS_ENCRYPTION_KEY is not configured on this environment, so credentials cannot be stored securely. Set it in Azure Key Vault first.",
      };
    }
    const parsed = credentialsInput.safeParse(raw);
    if (!parsed.success) {
      // Report the specific rule that failed — these messages name the field
      // and the expected shape, and never echo the submitted value.
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid values." };
    }

    const changed: IntegrationKey[] = [];
    for (const key of CREDENTIAL_KEYS) {
      const value = parsed.data[key];
      if (!value) continue; // blank = unchanged
      await setIntegrationSecret(key, value, staff.id);
      changed.push(key);
    }
    if (changed.length === 0) return { ok: true, message: "Nothing to update." };

    // Record WHICH credentials moved, never the values themselves.
    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "integration_credentials.update",
      entityType: "integration_credentials",
      entityId: changed.join(","),
      after: { updatedKeys: changed },
    });
    revalidatePath("/admin/settings/integrations");
    return { ok: true, message: `Saved ${changed.length} credential${changed.length === 1 ? "" : "s"}.` };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: "Not allowed" };
    console.error("[integrations] save failed");
    return { ok: false, error: "Could not save credentials." };
  }
}

export async function clearIntegrationCredentialAction(rawKey: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_integrations");
    const parsed = z.enum(CREDENTIAL_KEYS).safeParse(rawKey);
    if (!parsed.success) return { ok: false, error: "Unknown credential." };

    await clearIntegrationSecret(parsed.data);
    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "integration_credentials.clear",
      entityType: "integration_credentials",
      entityId: parsed.data,
    });
    revalidatePath("/admin/settings/integrations");
    return { ok: true, message: "Credential removed." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: "Not allowed" };
    console.error("[integrations] clear failed");
    return { ok: false, error: "Could not remove the credential." };
  }
}

const testInput = z.object({
  channel: z.enum(["sms", "email"]),
  to: z.string().trim().min(1).max(200),
});

/**
 * Sends through the real `sendMessage` path so a success here means customer
 * messages will work too. Note that outside production `sendMessage` is
 * deliberately log-only, so this reports "recorded" rather than claiming
 * delivery.
 */
export async function sendTestMessageAction(raw: unknown): Promise<ActionResult> {
  try {
    await requireStaff("manage_integrations");
    const parsed = testInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter a destination first." };
    const { channel, to } = parsed.data;

    const result = await sendMessage({
      channel,
      kind: "staff_alert",
      to,
      subject: "Test message — Personal Touch Car Detailing",
      body: "This is a test from your admin settings. If you received it, messaging is configured correctly.",
      relatedEntityType: "integration_test",
      relatedEntityId: channel,
    });

    if (result.sent) {
      return process.env.NODE_ENV === "production"
        ? { ok: true, message: `Test ${channel === "sms" ? "SMS" : "email"} sent to ${to}.` }
        : { ok: true, message: "Recorded locally — messages only leave the server in production." };
    }
    if (result.reason === "not_configured") {
      return { ok: false, error: `${channel === "sms" ? "Twilio" : "Resend"} credentials are incomplete.` };
    }
    return { ok: false, error: result.detail ? `Provider rejected it: ${result.detail}` : "The provider rejected the message." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: "Not allowed" };
    console.error("[integrations] test send failed");
    return { ok: false, error: "Could not send the test message." };
  }
}
