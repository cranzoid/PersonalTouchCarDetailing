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

/* ------------------------------------------------------------------ */
/* Public menu presentation                                            */
/* ------------------------------------------------------------------ */

/**
 * How the ceramic family appears to a customer choosing a service: TWO
 * products, coating first, protection second.
 *
 * The catalogue rows behind them stay separate, and deliberately so — booking,
 * pricing, invoices and reports all need "Crystal" and "Standalone" to be
 * distinct, priced things. But a menu is a place to choose between products,
 * not to read a price list, so the five rows collapse to the two decisions a
 * customer actually makes. The packages appear once they open the coating page.
 *
 * This is the ONLY place the collapsing is defined; the services menu and the
 * home page both render from `resolveCeramicMenu` so they cannot drift apart.
 */
type CeramicMenuDefinition = {
  key: string;
  /** Public-facing product name — never the row name with its suffix. */
  name: string;
  shortDescription: string;
  href: string;
  /** Where the headline "from" price comes from. */
  priceSource:
    | { kind: "cheapest-service"; slugs: readonly string[] }
    | { kind: "addon"; slug: string; fallbackServiceSlug: string };
};

const CERAMIC_MENU: readonly CeramicMenuDefinition[] = [
  {
    key: "ceramic-coating",
    name: "Ceramic Coating",
    shortDescription:
      "Our premium coating service, in three packages — Crystal, Pro and Max — with warranty options on Pro and Max.",
    href: CERAMIC_COATING_HUB_PATH,
    // The cheapest package is the honest "from", and it moves on its own if
    // the owner re-prices Crystal in Admin.
    priceSource: { kind: "cheapest-service", slugs: CERAMIC_COATING_SLUGS },
  },
  {
    key: "ceramic-protection",
    name: "Ceramic Protection",
    shortDescription:
      "A single layer of ceramic protection — added to an Ultimate Detail, or booked on its own.",
    href: CERAMIC_PROTECTION_PATH,
    // The add-on is the cheapest way to buy it, so it is the "from" price —
    // but it is conditional, which is what the footnote below carries.
    priceSource: {
      kind: "addon",
      slug: CERAMIC_PROTECTION_ADDON_SLUG,
      fallbackServiceSlug: CERAMIC_PROTECTION_SLUG,
    },
  },
];

export type ResolvedCeramicMenuProduct = {
  key: string;
  name: string;
  shortDescription: string;
  href: string;
  fromPriceCents: number;
  /**
   * Set when the headline price depends on something. Non-null means the
   * price MUST be rendered with an asterisk and this note beside it — the
   * $120 figure is never allowed to stand on its own.
   */
  priceNote: string | null;
};

/**
 * Resolves the two menu products against the live catalogue. Every price is
 * read from the rows passed in, so Admin → Services still moves the menu.
 *
 * A product whose price cannot be resolved — every package deactivated, say —
 * is omitted rather than shown at $0.
 */
export function resolveCeramicMenu(input: {
  services: readonly { slug: string; basePriceCents: number | null; active: boolean }[];
  addons: readonly { slug: string | null; priceCents: number; active: boolean }[];
}): ResolvedCeramicMenuProduct[] {
  const out: ResolvedCeramicMenuProduct[] = [];

  for (const entry of CERAMIC_MENU) {
    let fromPriceCents: number | null = null;
    let priceNote: string | null = null;

    if (entry.priceSource.kind === "cheapest-service") {
      const prices = input.services
        .filter((s) => s.active && entry.priceSource.kind === "cheapest-service" &&
          entry.priceSource.slugs.includes(s.slug) && s.basePriceCents !== null)
        .map((s) => s.basePriceCents!);
      if (prices.length > 0) fromPriceCents = Math.min(...prices);
    } else {
      const source = entry.priceSource;
      const addon = input.addons.find((a) => a.slug === source.slug && a.active);
      if (addon) {
        fromPriceCents = addon.priceCents;
        priceNote = `when added to an ${ULTIMATE_DETAIL_LABEL}`;
      } else {
        // The discounted route is unavailable, so the standalone price is the
        // only true "from" — and it carries no condition.
        const standalone = input.services.find(
          (s) => s.slug === source.fallbackServiceSlug && s.active && s.basePriceCents !== null,
        );
        if (standalone) fromPriceCents = standalone.basePriceCents!;
      }
    }

    if (fromPriceCents === null) continue;
    out.push({
      key: entry.key,
      name: entry.name,
      shortDescription: entry.shortDescription,
      href: entry.href,
      fromPriceCents,
      priceNote,
    });
  }

  return out;
}

/**
 * The menu product key a ceramic catalogue slug belongs to, for surfaces that
 * render individual rows (the home page's featured trio) and need to show the
 * product rather than the package behind it.
 */
export function ceramicMenuKeyFor(slug: string): string | undefined {
  if (isCeramicCoatingSlug(slug)) return CERAMIC_MENU[0].key;
  if (slug === CERAMIC_PROTECTION_SLUG) return CERAMIC_MENU[1].key;
  return undefined;
}

/**
 * How a ceramic catalogue slug should be named and linked when it is
 * referenced from another page. A "related services" chip is a menu, so it
 * names the product and links to the product page — never "Crystal" pointing
 * at one package as though it were the whole service.
 */
export function ceramicMenuLinkFor(slug: string): { name: string; href: string } | undefined {
  const entry = CERAMIC_MENU.find((product) => product.key === ceramicMenuKeyFor(slug));
  return entry ? { name: entry.name, href: entry.href } : undefined;
}

/** Every catalogue slug the menu resolves over — the rows a caller must load. */
export const CERAMIC_MENU_SERVICE_SLUGS: readonly string[] = [
  ...CERAMIC_COATING_SLUGS,
  CERAMIC_PROTECTION_SLUG,
];
