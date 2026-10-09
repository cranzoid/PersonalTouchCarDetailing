import type { BusinessSettings } from "@/lib/settings";

/**
 * Membership and Winter Pass settings. Kept on their own key in
 * business_settings and edited on their own page (Memberships → Settings),
 * apart from the general settings — the owners asked for that explicitly.
 */
export type MembershipSettings = {
  /** Memberships can be bought online. Off until Helcim is live. */
  salesOpen: boolean;
  /** The Winter Pass can be bought online. */
  passSalesOpen: boolean;
  winterPass: {
    name: string;
    /** Before tax. */
    priceCents: number;
    washesTotal: number;
    /** First and last business-local day a pass wash can be used, YYYY-MM-DD. */
    validFrom: string;
    validUntil: string;
    features: string[];
  };
  /**
   * Catalogue slugs the member discount applies to — the three detailing
   * packages. Coatings, PPF, tint and dash cams are deliberately absent.
   */
  discountServiceSlugs: string[];
  /** Add-ons booked alongside an eligible package take the discount too. */
  discountAddons: boolean;
  /** Priority booking: how much further ahead than everyone else a member may book. */
  priorityBookingExtraDays: number;
  /** Days after a failed monthly charge to try again; past the last, the membership ends. */
  retryDays: number[];
  /** How far ahead members are told about a plan change (the season turning over). */
  planChangeNoticeDays: number;
  /** Stamped on each sign-up and pass, so later wording changes never rewrite what was agreed. */
  termsVersion: string;
};

export const MEMBERSHIP_SETTINGS_DEFAULTS: MembershipSettings = {
  salesOpen: false,
  passSalesOpen: false,
  winterPass: {
    name: "Winter Pass",
    priceCents: 9900,
    washesTotal: 4,
    validFrom: "2026-11-01",
    validUntil: "2027-03-31",
    features: [
      "4 winter hand washes",
      "Prepaid",
      "Valid November through March",
      "Free underbody salt flush with every Winter Pass wash",
    ],
  },
  discountServiceSlugs: ["complete-detail-engine", "the-works", "interior-detail"],
  discountAddons: true,
  priorityBookingExtraDays: 30,
  retryDays: [3, 5, 7],
  planChangeNoticeDays: 14,
  termsVersion: "2026-10-winter",
};

/** Stored values over the defaults, field by field, so a new field never reads as undefined. */
export function membershipSettings(settings: Pick<BusinessSettings, "memberships">): MembershipSettings {
  const stored = (settings.memberships ?? {}) as Partial<MembershipSettings>;
  return {
    ...MEMBERSHIP_SETTINGS_DEFAULTS,
    ...stored,
    winterPass: { ...MEMBERSHIP_SETTINGS_DEFAULTS.winterPass, ...(stored.winterPass ?? {}) },
  };
}

/**
 * The fixed benefit vocabulary plans choose from, each mapped to the catalogue
 * service it stands for. Keyed by slug because the owners rename services in
 * Admin — "Basic Car Wash" is what the flyer calls a premium hand wash.
 */
export const MEMBERSHIP_BENEFITS = {
  wash: { label: "Premium hand wash", serviceSlug: "basic-car-wash" },
  interior: { label: "Basic interior clean", serviceSlug: "basic-interior-clean" },
} as const;
export type MembershipBenefit = keyof typeof MEMBERSHIP_BENEFITS;
export const BENEFIT_KEYS = Object.keys(MEMBERSHIP_BENEFITS) as MembershipBenefit[];

export function isBenefit(value: string): value is MembershipBenefit {
  return value in MEMBERSHIP_BENEFITS;
}

/** The catalogue service a Winter Pass wash is. */
export const WINTER_PASS_SERVICE_SLUG = "basic-car-wash";
