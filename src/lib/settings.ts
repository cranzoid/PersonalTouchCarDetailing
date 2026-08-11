import { db, schema } from "@/db";

/**
 * Typed business settings over the key/value businessSettings table.
 * Identity defaults below are owner-confirmed (2026-07-19); everything is
 * still staff-configurable in Admin → Settings. Anything marked
 * NEEDS-CONFIRMATION is also tracked in WORKFLOW.md under business questions.
 */

export type BusinessSettings = {
  businessName: string;
  /**
   * Incorporated entity behind the trade name, e.g. "1001646478 Ontario Inc.".
   * Printed on invoices under the trade name so the document ties the HST
   * number to the registrant. Blank hides the line.
   */
  legalEntityName: string;
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
  /**
   * Staff alerts. Recipients are plain contact strings rather than staff_users
   * rows on purpose: the manager account is shared by two or three people who
   * each want the text on their own phone. Provider credentials live in
   * integration_credentials, never here — this table is loaded into public
   * server components.
   */
  notifyOnNewAppointment: boolean;
  staffNotifyPhones: string[];
  staffNotifyEmails: string[];
  /** Ad-driven promotion. See src/lib/promotions.ts for how it is resolved. */
  promotion: Promotion;
};

/**
 * A single active ad promotion ("10% off your first detail"). Marketing copy
 * only — safe to sit in business_settings, which is loaded into public server
 * components.
 *
 * The customer never types the code: it rides in the ad URL as ?offer=CODE and
 * is applied automatically. Keep codes campaign-scoped (FIRST10AUG26, not
 * FIRST10) — the claim is persisted in the visitor's browser with no separate
 * expiry, so re-using a retired code would silently honour stale claims.
 * Changing the code is therefore the real kill switch.
 */
export type Promotion = {
  enabled: boolean;
  /** Matched case-insensitively against the ?offer= parameter. */
  code: string;
  /** Customer-facing line label, e.g. "First Detail Offer". */
  label: string;
  /** Percent off in basis points (1000 = 10%) — same convention as taxRateBp. */
  percentOffBp: number;
  /** Last valid business-local day, YYYY-MM-DD. Empty means no expiry. */
  expiresOn: string;
  firstTimeOnly: boolean;
  /**
   * Services the offer applies to. EMPTY MEANS NOTHING IS ELIGIBLE — the offer
   * fails closed so a new service is never enrolled by accident. The ad says
   * "detail", so ceramic coating, tint and PPF must be ticked in deliberately
   * or not at all.
   */
  eligibleServiceIds: string[];
};

export const SETTINGS_DEFAULTS: BusinessSettings = {
  businessName: "Personal Touch Car Detailing",
  legalEntityName: "1001646478 Ontario Inc.",
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
  taxRegistrationNumber: "707187431RT0001",
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
  notifyOnNewAppointment: true,
  staffNotifyPhones: [],
  staffNotifyEmails: [],
  // Ships disabled with nothing eligible: merging this never changes a price
  // until staff switch it on and tick the packages it covers.
  promotion: {
    enabled: false,
    code: "FIRST10AUG26",
    label: "First Detail Offer",
    percentOffBp: 1000,
    expiresOn: "",
    firstTimeOnly: true,
    eligibleServiceIds: [],
  },
};

export async function getSettings(): Promise<BusinessSettings> {
  const rows = await db().select().from(schema.businessSettings);
  const stored: Partial<BusinessSettings> = {};
  for (const row of rows) {
    (stored as Record<string, unknown>)[row.key] = row.value;
  }
  return { ...SETTINGS_DEFAULTS, ...stored };
}

const PUBLIC_SETTINGS_TTL_MS = 60_000;
let publicSettingsCache:
  | { expiresAt: number; value: Promise<BusinessSettings> }
  | undefined;

/**
 * Short process-local cache for public Server Components. Business settings
 * change infrequently, while the public layout and page can request the same
 * row set during every render. Mutating actions invalidate this process
 * immediately; other scaled-out workers expire their copy within one minute.
 */
export function getPublicSettings(): Promise<BusinessSettings> {
  const now = Date.now();
  if (!publicSettingsCache || publicSettingsCache.expiresAt <= now) {
    const pending = getSettings();
    const cached = pending.catch((error) => {
      if (publicSettingsCache?.value === cached) publicSettingsCache = undefined;
      throw error;
    });
    publicSettingsCache = {
      expiresAt: now + PUBLIC_SETTINGS_TTL_MS,
      value: cached,
    };
  }
  return publicSettingsCache.value;
}

export function invalidatePublicSettingsCache(): void {
  publicSettingsCache = undefined;
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
