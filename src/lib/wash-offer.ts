import { localDateISO } from "@/lib/tz";
import { VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import type { BusinessSettings } from "@/lib/settings";

/**
 * The new-customer wash offer ("your first hand wash, $15.99").
 *
 * Everything in this file is pure, so the money and expiry rules are
 * unit-testable without a database. The claim records themselves live in
 * `offer_claims` (see src/lib/wash-offer-claims.ts) — decision 14 said to
 * promote the settings blob to a table the moment an offer needed usage caps,
 * and "one wash per person, one per plate" is exactly that.
 *
 * WHY THIS IS NOT THE EXISTING `promotion` SLOT: that one is a percentage.
 * This offer charges $15.99 for any vehicle, against catalogue prices of $30
 * for a car and $35 for an SUV, pickup or van — 46.7% and 54.3% off the same
 * advertised figure. One price across two regular prices is precisely what a
 * rate cannot express, and rounding the two together would put a number on the
 * page that the booking then contradicts. So the promo PRICE is the anchor and
 * the discount is derived per vehicle from it.
 *
 * The map stays per-category even though every covered size now holds the same
 * number. It is the eligibility list as much as the price list — an absent
 * category is not covered, which is how commercial vehicles, quoted
 * individually, stay out of a fixed-price offer — and the day the owners want
 * a size priced differently again, that is a number in Admin rather than a
 * deploy.
 */

export type WashOffer = {
  enabled: boolean;
  /** Campaign code, also what rides in the ad URL as ?offer=. Uppercase. */
  code: string;
  /** Customer-facing line label, snapshotted onto the appointment. */
  label: string;
  /** Catalogue slug this offer buys. Slug, not id: ids differ per environment. */
  serviceSlug: string;
  /**
   * Promo price per vehicle category, in cents. Normally one figure repeated:
   * the offer is advertised as the same price whatever you drive.
   *
   * A CATEGORY ABSENT FROM THIS MAP IS NOT ELIGIBLE — the same fail-closed
   * rule as `promotion.eligibleServiceIds`. That is what keeps commercial
   * vehicles, which the catalogue prices by quote, out of a fixed-price offer.
   */
  priceCentsByCategory: Partial<Record<VehicleCategory, number>>;
  /** Days a claimed code stays valid. Owner-confirmed at 14. */
  claimValidDays: number;
  /** Last business-local day a NEW claim may be made. Empty means no close. */
  claimsCloseOn: string;
  /** Restrict to customers with no fulfilled detail on record. */
  firstTimeOnly: boolean;
  /** Send the unbooked-claim nudges. Off until SMS is registered and live. */
  remindersEnabled: boolean;
};

export type ResolvedWashOffer = {
  code: string;
  label: string;
  serviceSlug: string;
  priceCentsByCategory: Partial<Record<VehicleCategory, number>>;
  claimValidDays: number;
  firstTimeOnly: boolean;
  remindersEnabled: boolean;
  /** False once `claimsCloseOn` has passed: issued codes still work, new ones do not. */
  acceptingClaims: boolean;
};

/**
 * The offer as configured, or null if it is not running.
 *
 * Fails closed on every axis: disabled, no code, no service, or an empty price
 * map. An empty map deliberately means "no vehicle qualifies", never "every
 * vehicle is free".
 *
 * `claimsCloseOn` does NOT switch the offer off — it stops new claims. A code
 * already in someone's hand is honoured to its own expiry, because withdrawing
 * a coupon somebody is holding is exactly the kind of thing a promotion must
 * not do.
 */
export function activeWashOffer(
  settings: Pick<BusinessSettings, "washOffer" | "timezone">,
  nowMs: number = Date.now(),
): ResolvedWashOffer | null {
  const offer = settings.washOffer;
  if (!offer?.enabled) return null;
  const code = offer.code.trim().toUpperCase();
  if (!code) return null;
  if (!offer.serviceSlug.trim()) return null;
  if (offer.claimValidDays <= 0) return null;

  const prices = eligiblePrices(offer.priceCentsByCategory);
  if (Object.keys(prices).length === 0) return null;

  // Calendar comparison in the business timezone, like activePromotion: "claims
  // close Friday" is a date statement, and both sides are YYYY-MM-DD so string
  // order is date order.
  const acceptingClaims =
    !offer.claimsCloseOn || localDateISO(settings.timezone, 0, nowMs) <= offer.claimsCloseOn;

  return {
    code,
    label: offer.label,
    serviceSlug: offer.serviceSlug.trim(),
    priceCentsByCategory: prices,
    claimValidDays: offer.claimValidDays,
    firstTimeOnly: offer.firstTimeOnly,
    remindersEnabled: offer.remindersEnabled,
    acceptingClaims,
  };
}

/** The offer, but only if this claimed campaign code matches it. */
export function resolveWashOfferCode(
  settings: Pick<BusinessSettings, "washOffer" | "timezone">,
  claimedCode: string | undefined | null,
  nowMs: number = Date.now(),
): ResolvedWashOffer | null {
  const offer = activeWashOffer(settings, nowMs);
  if (!offer) return null;
  const claim = claimedCode?.trim().toUpperCase();
  return claim && claim === offer.code ? offer : null;
}

/** Drops categories that are unknown, non-integer or not a positive price. */
function eligiblePrices(
  raw: Partial<Record<VehicleCategory, number>>,
): Partial<Record<VehicleCategory, number>> {
  const prices: Partial<Record<VehicleCategory, number>> = {};
  for (const category of VEHICLE_CATEGORIES) {
    const cents = raw?.[category];
    if (typeof cents === "number" && Number.isInteger(cents) && cents > 0) {
      prices[category] = cents;
    }
  }
  return prices;
}

/** The promo price for this vehicle size, or null when it does not qualify. */
export function washOfferPriceCents(
  offer: ResolvedWashOffer,
  category: VehicleCategory,
): number | null {
  return offer.priceCentsByCategory[category] ?? null;
}

type DiscountLine = { serviceId?: string; priceCents: number };

/**
 * The offer expressed as a per-line discount, so it joins the same allocation
 * machinery every other saving uses.
 *
 * The wash is booked at its CATALOGUE price and the offer takes the difference
 * off, rather than the line simply being written at $15.99. That is what keeps
 * `appointments.discount_cents` honest, puts the real saving on the invoice,
 * and lets the counter-revision and reporting paths carry on unchanged. It is
 * also the only version that can be advertised: the struck-through price is
 * then the price the shop actually charges, not a number typed into an ad.
 *
 * Never negative — if the catalogue price ever falls below the promo price the
 * offer simply stops being worth anything, which is the correct behaviour and
 * not an error.
 */
export function washOfferAllocation(
  lines: readonly DiscountLine[],
  input: { serviceId: string; promoPriceCents: number },
): { allocation: number[]; applies: boolean } {
  let applies = false;
  const allocation = lines.map((line) => {
    // Only the first matching line: the offer buys one wash, not a fleet of
    // them, and a hand-built request must not be able to repeat the line.
    if (applies || line.serviceId !== input.serviceId) return 0;
    const off = line.priceCents - input.promoPriceCents;
    if (off <= 0) return 0;
    applies = true;
    return off;
  });
  return { allocation, applies };
}

/** When a code claimed now stops working. */
export function claimExpiresAt(offer: ResolvedWashOffer, claimedAtMs: number = Date.now()): Date {
  return new Date(claimedAtMs + offer.claimValidDays * 86_400_000);
}

/**
 * A licence plate reduced to the form it is compared in: letters and digits
 * only, uppercased. "CABC 123", "cabc-123" and "CABC123" are one plate, and
 * the shop writes it differently every time.
 *
 * Same contract as normalizePhone: the plate the customer's paperwork shows is
 * what gets stored on the vehicle; this is only the matching key.
 */
export function normalizePlate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const plate = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return plate.length > 0 ? plate : null;
}

/**
 * Claim-code alphabet: no I, L, O, S, U or 0/1, so a code read off a phone
 * screen and typed at the counter cannot land on a different claim. Shares the
 * intent of the id alphabet in src/lib/id.ts, uppercased because this one is
 * read aloud.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRTVWXYZ";
const CODE_BODY_LENGTH = 6;
export const CLAIM_CODE_PREFIX = "PTW";

/** Canonical comparison form: uppercase alphanumerics, no separators. */
export function normalizeClaimCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return code.length >= 4 && code.length <= 32 ? code : null;
}

/** "PTW-7QK2MB" — what the customer sees. Stored canonically, without the dash. */
export function formatClaimCode(code: string): string {
  const canonical = normalizeClaimCode(code) ?? code;
  return canonical.startsWith(CLAIM_CODE_PREFIX)
    ? `${CLAIM_CODE_PREFIX}-${canonical.slice(CLAIM_CODE_PREFIX.length)}`
    : canonical;
}

/**
 * A new claim code. Caller supplies the randomness so this stays pure and the
 * tests can pin a value; `issueClaimCode` in the claims module wires up crypto.
 */
export function claimCodeFromBytes(bytes: Uint8Array): string {
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) {
    body += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return `${CLAIM_CODE_PREFIX}${body}`;
}

/* ------------------------------------------------------------------ */
/* Customer-facing content                                             */
/* ------------------------------------------------------------------ */

/**
 * Public ad destination. Keep this short and stable: it is printed into ads,
 * analytics reports and code-delivery links, so changing it loses attribution
 * and makes old creative land on a dead page.
 */
export const FIRST_WASH_OFFER_PATH = "/offers/first-wash";

/**
 * Days after a claim on which an unbooked code is nudged, owner-confirmed at
 * three reminders across a fourteen-day window: an early one while the offer is
 * still the reason they are thinking about us, a mid-point one, and a last call
 * forty-eight hours out.
 *
 * Only ever one per tick per claim, so an outage cannot fire the backlog at
 * somebody all at once — the claim's counter decides which is next.
 */
export const OFFER_CLAIM_REMINDER_DAYS = [3, 7, 12] as const;

/**
 * The published terms, versioned. Stamped onto every claim so a later edit
 * cannot change what an outstanding code was issued under — the same reason
 * `tax_label` is snapshotted onto an invoice (DECISIONS.md #6).
 *
 * Bump this whenever the wording below changes in a way that alters the deal.
 * `2026-09.3` is the combined service, offer and electronic-message consent
 * displayed beside the claim checkbox. Earlier codes keep their snapshotted
 * version; reclaiming explicitly accepts and records the current one.
 */
export const WASH_OFFER_TERMS_VERSION = "2026-09.3";

/**
 * The offer in full, in the order it has to be read.
 *
 * Written out rather than assembled in the page because these sentences are the
 * offer: Canada's Competition Act requires the material terms of a promotion to
 * be stated clearly, and the saving claim to be measured against a price the
 * business actually charges. Every figure here is therefore passed in from the
 * live catalogue rather than typed, so the page can never advertise a
 * "regular price" the booking flow would not charge.
 */
export function washOfferTerms(input: {
  businessName: string;
  carRegularLabel: string;
  carOfferLabel: string;
  largeRegularLabel: string;
  largeOfferLabel: string;
  claimValidDays: number;
  taxLabel: string;
  cardPriceLabel: string;
  claimsCloseLabel: string | null;
}): string[] {
  // One price for every size is the offer as the owners set it, but the prices
  // are editable in Admin and these sentences ARE the offer — so the wording
  // follows the configuration rather than assuming it. A page that advertises
  // "the same whatever you drive" against a map that says otherwise is the one
  // failure this section exists to prevent.
  const onePrice = input.carOfferLabel === input.largeOfferLabel;
  return [
    `Available to new customers only — one promotional wash per person and per vehicle. ${input.businessName} may verify this before the wash.`,
    onePrice
      ? `${input.carOfferLabel} is the price for any coupe, sedan, SUV, pickup or van — the same whatever you drive — against regular prices of ${input.carRegularLabel} for a car and ${input.largeRegularLabel} for an SUV, pickup or van. Commercial vehicles are quoted individually and are not included.`
      : `${input.carOfferLabel} applies to a coupe or sedan, regularly ${input.carRegularLabel}. ${input.largeOfferLabel} applies to an SUV, pickup or van, regularly ${input.largeRegularLabel}. Commercial vehicles are quoted individually and are not included.`,
    "Covers the basic exterior wash only: a hand wash, dry and mats. Interior cleaning, waxing and any other extra is charged at the usual price.",
    "100% hand wash. No automatic brushes are used on any vehicle, on this offer or otherwise.",
    `Prices exclude ${input.taxLabel}. Cash and Interac e-transfer pay the listed price; card and cheque add ${input.taxLabel} (${input.cardPriceLabel}${onePrice ? " in total" : " for a car"}).`,
    `Book your appointment within ${input.claimValidDays} days of claiming. Appointments are subject to availability and the offer cannot be used as a walk-in without one.`,
    "Cannot be combined with any other offer, discount or package deal.",
    input.claimsCloseLabel
      ? `New claims close on ${input.claimsCloseLabel}. A code already issued stays valid for its full ${input.claimValidDays} days.`
      : `The offer may be withdrawn at any time. A code already issued stays valid for its full ${input.claimValidDays} days.`,
    "Heavily soiled vehicles may need extra time, which is always discussed and agreed before any additional charge.",
  ];
}
