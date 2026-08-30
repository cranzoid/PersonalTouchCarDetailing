/**
 * Ceramic protection and ceramic coating are two DIFFERENT products. They are
 * never interchangeable in copy, pricing, booking or billing:
 *
 *   Ceramic Protection — a single layer of ceramic protection. Sold either as
 *     an Ultimate Detail add-on (the discounted price) or standalone.
 *   Ceramic Coating   — the premium multi-package coating service (Crystal,
 *     Pro, Max), each its own bookable catalogue service.
 *
 * Prices, durations and vehicle adjustments all live in the database and are
 * edited in Admin → Services, exactly like every other bookable service. This
 * module holds only the things a price column cannot: which slugs are ceramic,
 * the editorial content, and the condition disclaimer. It deliberately
 * contains NO pricing — there is one pricing system, and this is not it.
 *
 * Brand neutrality is a hard rule: no coating manufacturer or product brand
 * appears in any customer-facing string here or anywhere downstream.
 */

/** Catalogue slug of the package the discounted add-on price is tied to. */
export const ULTIMATE_DETAIL_SLUG = "complete-detail-engine";

/**
 * Display name used only where we must NAME the qualifying package in copy.
 * The catalogue row is the authority for the package's own label — the owner
 * renamed it in Admin and that name is what appears on the service card — but
 * a sentence like "when added to an Ultimate Detail" needs a stable noun that
 * does not swing with the "#1 - " numbering prefix.
 */
export const ULTIMATE_DETAIL_LABEL = "Ultimate Detail";

export const CERAMIC_PROTECTION_SLUG = "ceramic-protection";
export const CERAMIC_PROTECTION_ADDON_SLUG = "ceramic-protection-ultimate";

export const CERAMIC_COATING_SLUGS = [
  "ceramic-coating-crystal",
  "ceramic-coating-pro",
  "ceramic-coating-max",
] as const;
export type CeramicCoatingSlug = (typeof CERAMIC_COATING_SLUGS)[number];

/** Hub page for the three coating packages. Not a catalogue service. */
export const CERAMIC_COATING_HUB_PATH = "/services/ceramic-coating";
export const CERAMIC_PROTECTION_PATH = "/services/ceramic-protection";

/** Every ceramic slug that is a bookable catalogue service. */
export const CERAMIC_SERVICE_SLUGS: readonly string[] = [
  CERAMIC_PROTECTION_SLUG,
  ...CERAMIC_COATING_SLUGS,
];

export function isCeramicServiceSlug(slug: string): boolean {
  return CERAMIC_SERVICE_SLUGS.includes(slug);
}

export function isCeramicCoatingSlug(slug: string): slug is CeramicCoatingSlug {
  return (CERAMIC_COATING_SLUGS as readonly string[]).includes(slug);
}

/**
 * Shown wherever a ceramic price is quoted before the paint has been seen.
 *
 * Paint correction is NEVER folded into a coating price. If enhancement or
 * correction turns out to be needed it goes through the existing additional-
 * work approval flow, priced and approved on its own before it starts.
 */
export const CERAMIC_CONDITION_DISCLAIMER =
  "The displayed price covers the selected ceramic coating service for the chosen vehicle category. " +
  "Paint correction, excessive contamination, previous coating removal, or other condition-dependent " +
  "preparation may cost extra. Any additional work and pricing will be discussed with you and approved " +
  "before it begins.";

/** Same rule, one line, for tight spaces like the booking summary. */
export const CERAMIC_CONDITION_DISCLAIMER_SHORT =
  "Price covers the coating for this vehicle category. Paint correction, heavy contamination or removal " +
  "of a previous coating is condition-dependent, quoted separately and approved by you before it starts.";

/**
 * The qualification that must travel with the discounted add-on price
 * everywhere it is shown. The $120 figure is never allowed to appear as the
 * price of a ceramic coating, and never without this sentence beside it.
 */
export const CERAMIC_PROTECTION_ADDON_QUALIFIER =
  `Available at this price when added to an ${ULTIMATE_DETAIL_LABEL}. Booked on its own, ceramic ` +
  "protection is priced as a standalone service.";

export type CoatingPackageContent = {
  slug: CeramicCoatingSlug;
  /** Short label for tabs and comparison headers, without the family name. */
  tier: string;
  tagline: string;
  /** Null when the package carries no warranty. */
  warrantyYears: number | null;
  includes: readonly string[];
  bestFor: string;
};

/**
 * Editorial content for the three packages. Deliberately describes what each
 * package DOES rather than ranking them as steps — Crystal is a complete
 * service in its own right, not "step one" of anything.
 */
export const COATING_PACKAGES: readonly CoatingPackageContent[] = [
  {
    slug: "ceramic-coating-crystal",
    tier: "Crystal",
    tagline: "Vehicle wash, paint preparation and coating application.",
    warrantyYears: null,
    includes: [
      "Full hand wash and dry",
      "Chemical and mechanical decontamination",
      "Paint preparation ahead of application",
      "Ceramic coating applied by hand, panel by panel",
      "Controlled initial cure before collection",
    ],
    bestFor:
      "Newer vehicles, or paint already in good condition, where the goal is easier washing and a durable protective layer rather than defect removal.",
  },
  {
    slug: "ceramic-coating-pro",
    tier: "Pro",
    tagline: "A higher-grade coating with a six-year warranty.",
    warrantyYears: 6,
    includes: [
      "Everything in Crystal",
      "Higher-grade coating chemistry with longer service life",
      "Additional preparation time before application",
      "Extended controlled cure",
      "Six-year coating warranty",
    ],
    bestFor:
      "Daily drivers kept long term, where the owner wants a materially longer protection window and a warranty behind it.",
  },
  {
    slug: "ceramic-coating-max",
    tier: "Max",
    tagline: "Our longest-lasting coating, with a premium top layer and a ten-year warranty.",
    warrantyYears: 10,
    includes: [
      "Everything in Pro",
      "Premium top layer compared with Pro",
      "Our most thorough preparation stage",
      "Extended controlled cure",
      "Ten-year coating warranty",
    ],
    bestFor:
      "Vehicles being kept for the long term, and owners who want the most durable finish and the longest warranty we offer.",
  },
];

export function coatingPackage(slug: string): CoatingPackageContent | undefined {
  return COATING_PACKAGES.find((pkg) => pkg.slug === slug);
}

export function warrantyLabel(years: number | null): string {
  return years === null ? "No warranty" : `${years}-year warranty`;
}
