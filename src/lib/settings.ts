import { db, schema } from "@/db";

/**
 * Typed business settings over the key/value businessSettings table.
 * Defaults below are SAFE PLACEHOLDERS — real values are staff-configurable
 * in Admin → Settings. Anything marked NEEDS-CONFIRMATION is also tracked in
 * WORKFLOW.md under business questions.
 */

export type BusinessSettings = {
  businessName: string;
  addressLine1: string; // NEEDS-CONFIRMATION
  city: string;
  province: string;
  postalCode: string; // NEEDS-CONFIRMATION
  phone: string; // NEEDS-CONFIRMATION
  email: string; // NEEDS-CONFIRMATION
  timezone: string;
  /** Ontario HST default; staff-configurable. */
  taxRateBp: number;
  taxLabel: string;
  taxRegistrationNumber: string; // NEEDS-CONFIRMATION
  currency: string;
  /** Booking rules */
  slotGranularityMin: number;
  setupBufferMin: number;
  cleanupBufferMin: number;
  minBookingNoticeHours: number;
  maxBookingWindowDays: number;
  cancellationNoticeHours: number; // NEEDS-CONFIRMATION
  depositDefaultType: "none" | "fixed" | "percent";
  depositDefaultValue: number;
};

export const SETTINGS_DEFAULTS: BusinessSettings = {
  businessName: "Personal Touch Car Detailing",
  addressLine1: "[street address pending confirmation]",
  city: "Hamilton",
  province: "ON",
  postalCode: "",
  phone: "",
  email: "",
  timezone: "America/Toronto",
  taxRateBp: 1300,
  taxLabel: "HST",
  taxRegistrationNumber: "",
  currency: "CAD",
  slotGranularityMin: 30,
  setupBufferMin: 15,
  cleanupBufferMin: 15,
  minBookingNoticeHours: 24,
  maxBookingWindowDays: 60,
  cancellationNoticeHours: 48,
  depositDefaultType: "none",
  depositDefaultValue: 0,
};

export async function getSettings(): Promise<BusinessSettings> {
  const rows = await db().select().from(schema.businessSettings);
  const stored: Partial<BusinessSettings> = {};
  for (const row of rows) {
    (stored as Record<string, unknown>)[row.key] = row.value;
  }
  return { ...SETTINGS_DEFAULTS, ...stored };
}

export async function setSetting<K extends keyof BusinessSettings>(
  key: K,
  value: BusinessSettings[K],
  updatedByStaffId?: string,
): Promise<void> {
  await db()
    .insert(schema.businessSettings)
    .values({ key, value, updatedByStaffId })
    .onConflictDoUpdate({
      target: schema.businessSettings.key,
      set: { value, updatedAt: new Date(), updatedByStaffId },
    });
}
