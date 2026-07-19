"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings, setSetting, type BusinessSettings } from "@/lib/settings";

const settingsInput = z.object({
  businessName: z.string().trim().min(1).max(200),
  addressLine1: z.string().trim().max(300),
  city: z.string().trim().max(100),
  province: z.string().trim().max(10),
  postalCode: z.string().trim().max(10),
  phone: z.string().trim().max(30),
  email: z.string().trim().email().max(200).or(z.literal("")),
  taxRateBp: z.number().int().min(0).max(3000),
  taxRegistrationNumber: z.string().trim().max(50),
  slotGranularityMin: z.number().int().min(15).max(120),
  setupBufferMin: z.number().int().min(0).max(120),
  cleanupBufferMin: z.number().int().min(0).max(120),
  minBookingNoticeHours: z.number().int().min(0).max(24 * 14),
  maxBookingWindowDays: z.number().int().min(1).max(365),
  cancellationNoticeHours: z.number().int().min(0).max(24 * 14),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function updateSettingsAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_settings");
    const parsed = settingsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — please check the fields" };
    const input = parsed.data;

    const before = await getSettings();
    for (const [key, value] of Object.entries(input) as [keyof BusinessSettings, never][]) {
      await setSetting(key, value, staff.id);
    }
    // Tax and business-identity changes are sensitive; audit the whole diff.
    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "settings.updated",
      entityType: "business_settings",
      entityId: "default",
      before: Object.fromEntries(Object.keys(input).map((k) => [k, before[k as keyof BusinessSettings]])),
      after: input,
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateSettingsAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
