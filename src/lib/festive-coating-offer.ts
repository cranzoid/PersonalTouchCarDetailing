import type { VehicleCategory } from "./types";

/**
 * The Navratri & Diwali ceramic coating offer, reached only from a QR code
 * shared in WhatsApp and Facebook groups.
 *
 * Deliberately NOT catalogue data or a promo code (owner, 2026-10-16): the page
 * collects a callback request, and the price is settled with the customer when
 * the shop rings them. So nothing here can be claimed online, and nothing in
 * Admin changes. What it does own is the advertised figure, and the regular
 * prices that figure is compared against.
 */
export const FESTIVE_COATING_OFFER_PATH = "/offers/festive-coating";

/** One price for every vehicle size the shop publishes a price for. */
export const FESTIVE_COATING_OFFER_CENTS = 19_900;

/** The package on offer. Its catalogue row supplies the crossed-out prices. */
export const FESTIVE_COATING_SERVICE_SLUG = "ceramic-coating-crystal";

/** Tags the lead so the request can be told apart from a general quote. */
export const FESTIVE_COATING_ENQUIRY_TYPE = "festive_coating_qr";

export const FESTIVE_CAR_CATEGORIES = ["coupe", "sedan"] as const satisfies readonly VehicleCategory[];
export const FESTIVE_LARGE_CATEGORIES = ["suv_small", "suv_large", "pickup", "van"] as const satisfies readonly VehicleCategory[];

export type FestiveRegularPrices = {
  /** The car figure to strike through, or null when it would not be a saving. */
  carCents: number | null;
  /** The SUV / pickup / van figure, or null when it would not be a saving. */
  largeCents: number | null;
};

/**
 * The regular prices the page may cross out, read from the live catalogue.
 *
 * Crystal is $399 for a car and $499 for anything larger, so "was $399" is only
 * true for a car — each size shows its own figure. Where sizes in a group
 * differ, the LOWEST is shown, so the claimed saving is never larger than the
 * smallest real one. A figure that is not above the offer price is dropped: it
 * would advertise a saving that does not exist.
 */
export function festiveRegularPrices(
  basePriceCents: number | null,
  adjustments: readonly { vehicleCategory: string; priceDeltaCents: number }[],
): FestiveRegularPrices {
  if (basePriceCents === null) return { carCents: null, largeCents: null };
  const priceFor = (category: VehicleCategory) =>
    basePriceCents + (adjustments.find((row) => row.vehicleCategory === category)?.priceDeltaCents ?? 0);
  const lowest = (categories: readonly VehicleCategory[]) => {
    const cents = Math.min(...categories.map(priceFor));
    return cents > FESTIVE_COATING_OFFER_CENTS ? cents : null;
  };
  return { carCents: lowest(FESTIVE_CAR_CATEGORIES), largeCents: lowest(FESTIVE_LARGE_CATEGORIES) };
}
