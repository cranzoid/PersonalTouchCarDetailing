import { db, schema } from "@/db";

/**
 * Typed business settings over the key/value businessSettings table.
 * Identity defaults below are owner-confirmed (2026-07-19); everything is
 * still staff-configurable in Admin → Settings. Anything marked
 * NEEDS-CONFIRMATION is also tracked in WORKFLOW.md under business questions.
 */

export type BusinessSettings = {
  businessName: string;
  addressLine1: string;
  city: string;
  province: string;
  postalCode: string;
  phone: string;
  email: string;
  /** Public Google review destination shown on the Reviews page. */
  googleReviewUrl: string;
  timezone: string;
  /** Ontario HST default; staff-configurable. */
  taxRateBp: number;
  taxLabel: string;
  taxRegistrationNumber: string; // NEEDS-CONFIRMATION — owner enters in Admin → Settings
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
  /** Phase 5 automation cadences — all staff-configurable in Admin → Settings. */
  reminderLeadHours: number; // NEEDS-CONFIRMATION — how far ahead of an appointment to text a reminder
  reviewRequestDelayHours: number; // NEEDS-CONFIRMATION — how long after an invoice is paid to ask for a review
  maintenanceReminderMonths: number; // NEEDS-CONFIRMATION — how long after a completed job to suggest the next visit
};

export const SETTINGS_DEFAULTS: BusinessSettings = {
  businessName: "Personal Touch Car Detailing",
  addressLine1: "2481 Upper James St",
  city: "Hamilton",
  province: "ON",
  postalCode: "L0R 1W0",
  phone: "905-679-0143",
  email: "info@personaltouchcardetailing.ca",
  googleReviewUrl: "https://share.google/s5WvXvgHbcWAiornU",
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
  reminderLeadHours: 24,
  reviewRequestDelayHours: 24,
  maintenanceReminderMonths: 4,
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
