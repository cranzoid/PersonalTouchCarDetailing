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
 * Every field is optional and blank means "leave as-is". The form never
 * receives existing secrets, so submitting it must not be able to wipe them.
 */
const credentialsInput = z.object({
  twilioAccountSid: z.string().trim().max(200).optional(),
  twilioAuthToken: z.string().trim().max(200).optional(),
  twilioFromNumber: z.string().trim().max(30).optional(),
  resendApiKey: z.string().trim().max(200).optional(),
  emailFrom: z.string().trim().max(200).optional(),
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
    if (!parsed.success) return { ok: false, error: "Invalid values — check the field lengths." };

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
