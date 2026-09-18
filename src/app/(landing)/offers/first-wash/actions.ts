"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { consumeRateLimit } from "@/lib/rate-limit";
import { formatCents, withTaxCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getAppBaseUrl } from "@/lib/urls";
import { priceBooking, PricingError } from "@/lib/pricing";
import { getAvailableSlots } from "@/lib/booking/availability";
import { createAppointment, BookingError, OfferChangedError } from "@/lib/booking/create";
import { appointmentWhenLabel } from "@/lib/appointment-time";
import { notifyStaffOfNewAppointment } from "@/lib/staff-notifications";
import type { VehicleCategory } from "@/lib/types";
import {
  activeWashOffer,
  formatClaimCode,
  WASH_OFFER_TERMS_VERSION,
  washOfferPriceCents,
  type ResolvedWashOffer,
  type WashOfferFlow,
} from "@/lib/wash-offer";
import { issueClaim, lookupClaim, sendClaimMessages, type OfferClaim } from "@/lib/wash-offer-claims";
import type { Attribution } from "@/db/schema";

const claimSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  // Required. The offer's "one per customer" cap is keyed on this, and it is
  // how the shop reaches someone about an appointment.
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(200),
  vehicleSize: z.enum(["car", "suv"]),
  termsAccepted: z.literal(true),
  attribution: z.record(z.string(), z.unknown()).optional(),
});

export type ClaimResult =
  | {
      ok: true;
      /**
       * What the page does next. `book_first` means the claim exists but
       * nothing has been sent — the visitor now picks a time on this same page
       * and the code is handed over with the confirmation.
       */
      flow: WashOfferFlow;
      /** "PTW-7QK2MB" — display form, and what the booking calls send back. */
      code: string;
      expiresLabel: string;
      /** Deep link that carries the claim into the booking wizard. */
      bookingPath: string;
      /** False when this contact already held a code and we returned it. */
      isNew: boolean;
      /** The claim has been spent already; the UI says so rather than promising a wash. */
      alreadyUsed: boolean;
      /**
       * Spent on an appointment that has not happened yet, and when it is.
       * Distinct from `alreadyUsed` because the two need opposite answers:
       * somebody who has already had the wash is being turned down, and
       * somebody who booked it an hour ago and came back for the code is being
       * reminded. Null once the wash has actually been redeemed.
       */
      bookedWhenLabel: string | null;
      expired: boolean;
      sentBy: ("sms" | "email")[];
      priceLabel: string;
      /** The same wash paid for by card or cheque. See DECISIONS.md #18. */
      priceWithTaxLabel: string;
    }
  | { ok: false; error: string };

/**
 * Claims the new-customer wash offer.
 *
 * Note what this does NOT do: tell the browser whether the person is already a
 * customer. Re-claiming returns the code they already hold, so the response is
 * the same either way and the form cannot be used to ask whether a phone number
 * is on our books — the oracle DECISIONS.md #14 refused to build. Eligibility
 * as a *new customer* is settled at booking, server-side, and again at the
 * counter against the licence plate.
 *
 * The claim is created in BOTH arms of the A/B test, and identically. Only the
 * delivery differs: `code_first` sends the code now, `book_first` sends nothing
 * until an appointment exists. That is deliberate — a visitor who gives their
 * details and then abandons the time picker is still a lead the shop can work,
 * and the nudges already know how to chase an unbooked claim.
 */
export async function claimWashOfferAction(raw: unknown): Promise<ClaimResult> {
  const rate = await consumeRateLimit("wash-offer-claim", { limit: 8, windowMs: 60 * 60_000 });
  if (!rate.allowed) {
    return { ok: false, error: "Too many attempts from this connection. Please try again later, or call us." };
  }
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please check every field and accept the Terms & Conditions." };
  }
  const input = parsed.data;

  try {
    const settings = await getSettings();
    const offer = activeWashOffer(settings);
    if (!offer) return { ok: false, error: "This offer has finished. Please see our current prices, or call us." };
    if (!offer.acceptingClaims) {
      return { ok: false, error: "Claims for this offer have closed. Please call us — we may still be able to help." };
    }

    const { claim, created } = await issueClaim({
      offer,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      vehicleSize: input.vehicleSize,
      marketingConsent: true,
      termsVersion: WASH_OFFER_TERMS_VERSION,
      attribution: (input.attribution ?? undefined) as Attribution | undefined,
    });

    const displayCode = formatClaimCode(claim.code);
    const expiresLabel = formatInZone(claim.expiresAt, settings.timezone, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const alreadyUsed = claim.status === "booked" || claim.status === "redeemed";
    const expired = claim.status === "expired" || claim.expiresAt.getTime() <= Date.now();
    const bookedWhenLabel =
      claim.status === "booked" && claim.appointmentId
        ? await appointmentWhenLabelFor(claim.appointmentId, settings.timezone)
        : null;
    const priceCents = washOfferPriceCents(offer, categoryFor(claim.vehicleSize));
    const priceLabel = priceCents === null ? "" : formatCents(priceCents, settings.currency);
    const priceWithTaxLabel =
      priceCents === null ? "" : formatCents(withTaxCents(priceCents, settings.taxRateBp), settings.currency);
    const bookingPath = `/book?service=${encodeURIComponent(offer.serviceSlug)}&offer=${encodeURIComponent(offer.code)}&claim=${encodeURIComponent(claim.code)}`;

    // Delivery is best effort and deliberately secondary: the code is on the
    // screen in front of them. SMS in particular cannot be relied on until the
    // carrier registration is finished, and a funnel that depends on a text
    // arriving is a funnel that stops working the day the provider does.
    //
    // In the book-first arm nothing is sent here AT ALL. Texting the code at
    // this point would hand over the thing the test is withholding, and the
    // customer would be left holding a coupon and half a booking.
    let sentBy: ("sms" | "email")[] = [];
    // Re-send an existing live code too. Someone returning because they lost a
    // message should receive the same useful response as a first-time claim.
    if (offer.flow === "code_first" && !alreadyUsed && !expired) {
      sentBy = await sendClaimMessages({
        claim,
        offer,
        settings,
        variant: "code",
        baseUrl: safeBaseUrl(),
      });
    }

    return {
      ok: true,
      flow: offer.flow,
      code: displayCode,
      expiresLabel,
      bookingPath,
      isNew: created,
      alreadyUsed,
      bookedWhenLabel,
      expired,
      sentBy,
      priceLabel,
      priceWithTaxLabel,
    };
  } catch (err) {
    console.error("claimWashOfferAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again, or call us and we will sort it out." };
  }
}

/* ------------------------------------------------------------------ */
/* Booking the wash on the offer page itself                           */
/* ------------------------------------------------------------------ */

const slotsSchema = z.object({
  code: z.string().trim().min(4).max(32),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type WashSlotsResult =
  | { ok: true; slots: { startMs: number; label: string }[] }
  | { ok: false; error: string };

/**
 * Times available for one claim's wash, on one day.
 *
 * The browser names a DATE and a CODE, never a service, a price or a duration.
 * Everything else is read from the offer and the claim the code resolves to, so
 * a hand-built request cannot ask for the availability of a job it has not
 * bought — and cannot use this to enumerate codes either: every failure below
 * returns the same shape as an ordinary closed day.
 */
export async function washOfferSlotsAction(raw: unknown): Promise<WashSlotsResult> {
  const rate = await consumeRateLimit("wash-offer-slots", { limit: 60, windowMs: 5 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many availability checks. Please wait a moment." };
  const parsed = slotsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please choose a date." };

  try {
    const context = await loadClaimBookingContext(parsed.data.code);
    if (!context.ok) return { ok: false, error: context.error };
    const { settings, pricing } = context;

    const slots = await getAvailableSlots({
      dateISO: parsed.data.dateISO,
      workDurationMin: pricing.durationMin,
      settings,
      requiredSkills: pricing.requiredSkills,
    });
    return {
      ok: true,
      slots: slots.map((slot) => ({
        startMs: slot.start,
        label: formatInZone(new Date(slot.start), settings.timezone, { hour: "numeric", minute: "2-digit" }),
      })),
    };
  } catch (err) {
    if (err instanceof PricingError) return { ok: false, error: err.message };
    console.error("washOfferSlotsAction failed", err);
    return { ok: false, error: "Could not load available times. Please try again, or call us." };
  }
}

const bookSchema = z.object({
  code: z.string().trim().min(4).max(32),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMs: z.number().int().positive(),
});

export type WashBookingResult =
  | {
      ok: true;
      /** "PTW-7QK2MB" — shown on the confirmation and asked for at the counter. */
      code: string;
      whenLabel: string;
      priceLabel: string;
      priceWithTaxLabel: string;
      sentBy: ("sms" | "email")[];
    }
  | {
      ok: false;
      /** The time went, or the offer did: the picker reopens rather than the page dying. */
      retry: boolean;
      error: string;
    };

/**
 * Books the wash and spends the claim, from the offer page.
 *
 * This is the booking wizard's `submitBookingAction` with everything the
 * customer has already told us filled in from the claim rather than re-asked:
 * the name, the contact details and the vehicle size were given to get the
 * code, and asking for them twice is the friction this whole change exists to
 * remove. It goes through exactly the same `createAppointment`, so the caps,
 * the double-booking lock, the first-time-customer re-check and the conditional
 * spend of the claim are the ones that were already proven — nothing about the
 * money is reimplemented here.
 *
 * `policiesAccepted` is true because it was: the claim form's checkbox names
 * the service terms, the cancellation policy and the privacy policy, and the
 * version accepted is stamped on the claim row this booking is made from.
 */
export async function bookWashOfferAction(raw: unknown): Promise<WashBookingResult> {
  const rate = await consumeRateLimit("wash-offer-book", { limit: 6, windowMs: 60 * 60_000 });
  if (!rate.allowed) {
    return { ok: false, retry: false, error: "Too many booking attempts. Please try again later, or call us." };
  }
  const parsed = bookSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, retry: true, error: "Please choose a date and a time." };
  const input = parsed.data;

  try {
    const context = await loadClaimBookingContext(input.code);
    if (!context.ok) return { ok: false, retry: false, error: context.error };
    const { settings, offer, claim, pricing } = context;

    // The offer has to have actually paid for something. A zero discount here
    // means the catalogue price fell to the promo price, or the claim stopped
    // covering this vehicle — either way the customer would be booking at full
    // price on a page that says otherwise.
    if (pricing.discountCents <= 0 || pricing.promoCode !== offer.code) {
      return {
        ok: false,
        retry: false,
        error: "This offer no longer applies to that vehicle. Please call us and we will sort it out.",
      };
    }
    // A wash takes no deposit, and this page cannot collect one: it has no
    // payment step. If the catalogue ever says otherwise, send them to the
    // booking page that can, rather than creating an unpayable reservation.
    if (pricing.depositRequiredCents > 0) {
      return {
        ok: false,
        retry: false,
        error: "This booking needs a deposit, which we take on the main booking page. Please call us and we will help.",
      };
    }

    const result = await createAppointment({
      customer: {
        firstName: claim.firstName,
        lastName: claim.lastName,
        email: claim.email ?? undefined,
        phone: claim.phone ?? undefined,
        preferredContact: claim.email ? "email" : "phone",
      },
      // Make and model are not asked for. The offer page trades them for the
      // conversion — the wash is priced by size, the counter records the plate,
      // and staff fill the rest in on the appointment if they want it.
      vehicle: {
        make: "",
        model: "",
        category: categoryFor(claim.vehicleSize),
      },
      pricing,
      dateISO: input.dateISO,
      startMs: input.startMs,
      // Captured when they landed on the ad, not re-supplied by the browser
      // now: the claim already holds the attribution this booking belongs to.
      attribution: (claim.attribution ?? undefined) as Attribution | undefined,
      policiesAccepted: true,
      settings,
      washClaim: { offer, code: claim.code },
    });

    const whenLabel = appointmentWhenLabel(result, settings.timezone, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const priceCents = washOfferPriceCents(offer, categoryFor(claim.vehicleSize)) ?? 0;
    const priceLabel = formatCents(priceCents, settings.currency);
    const priceWithTaxLabel = formatCents(withTaxCents(priceCents, settings.taxRateBp), settings.currency);

    // One message carrying both facts. The ordinary booking confirmation is
    // deliberately not sent as well — see the template comment in seed-runner.
    let sentBy: ("sms" | "email")[] = [];
    try {
      sentBy = await sendClaimMessages({
        claim,
        offer,
        settings,
        variant: "booked",
        baseUrl: safeBaseUrl(),
        // No taxLabel here on purpose. The template says "plus tax" in words,
        // like additional_work_request does, so the body renders correctly on
        // the build running BEFORE this deploy as well as after it — migration
        // 0029 lands on the shared database while the old build is still
        // serving, and renderTemplate blanks a variable it was not given.
        extraVariables: { when: whenLabel, priceWithTax: priceWithTaxLabel },
      });
    } catch {
      console.error("Wash offer booked but the confirmation could not be queued");
    }

    // Independent of the customer's message: the owner wants to know about the
    // booking even if the confirmation bounced.
    try {
      await notifyStaffOfNewAppointment(result.appointmentId);
    } catch {
      console.error("Wash offer booked but the staff alert could not be queued");
    }

    return { ok: true, code: formatClaimCode(claim.code), whenLabel, priceLabel, priceWithTaxLabel, sentBy };
  } catch (err) {
    // Lost a re-check inside the booking transaction: nothing was written.
    if (err instanceof OfferChangedError) {
      return {
        ok: false,
        // "Returning customer" and "already spent" are final; a withdrawn
        // offer is not something another time slot fixes either.
        retry: false,
        error:
          err.reason === "returning"
            ? "This offer is for first-time customers, so we could not apply it. Please call us — we would still like to see you."
            : "That code has already been used. Please call us and we will see what we can do.",
      };
    }
    if (err instanceof BookingError) {
      // Almost always "that time is no longer available": somebody else took
      // the slot while this form was open. Reopen the picker.
      return { ok: false, retry: true, error: err.message };
    }
    if (err instanceof PricingError) return { ok: false, retry: false, error: err.message };
    console.error("bookWashOfferAction failed", err);
    return { ok: false, retry: true, error: "Something went wrong booking your wash. Please try again, or call us." };
  }
}

type ClaimBookingContext =
  | {
      ok: true;
      settings: Awaited<ReturnType<typeof getSettings>>;
      offer: ResolvedWashOffer;
      claim: OfferClaim;
      pricing: Awaited<ReturnType<typeof priceBooking>>;
    }
  | { ok: false; error: string };

/**
 * Everything the two booking calls need, resolved from a code alone.
 *
 * Both of them have to agree about the service, the vehicle size, the duration
 * and the price, so both read it from here. The price is computed by
 * `priceBooking` with the offer attached — the same call the booking wizard
 * makes — which is what keeps the figure on the offer page and the figure on
 * the appointment the same number.
 */
async function loadClaimBookingContext(rawCode: string): Promise<ClaimBookingContext> {
  const settings = await getSettings();
  const offer = activeWashOffer(settings);
  if (!offer) {
    return { ok: false, error: "This offer has finished. Please see our current prices, or call us." };
  }

  const lookup = await lookupClaim(db(), offer.code, rawCode);
  if (!lookup.ok) {
    return {
      ok: false,
      error:
        lookup.reason === "expired"
          ? "That code has expired. Please call us and we will see what we can do."
          : lookup.reason === "spent"
            ? "That code has already been used. Please call us if you need to change your appointment."
            : "We could not find that code. Please claim it again, or call us.",
    };
  }
  const claim = lookup.claim;

  const [service] = await db()
    .select()
    .from(schema.services)
    .where(and(eq(schema.services.slug, offer.serviceSlug), eq(schema.services.active, true)))
    .limit(1);
  if (!service) {
    return { ok: false, error: "This offer is not bookable online right now. Please call us and we will book it." };
  }

  const pricing = await priceBooking({
    serviceIds: [service.id],
    addonIds: [],
    vehicleCategory: categoryFor(claim.vehicleSize),
    settings,
    washOffer: offer,
  });
  return { ok: true, settings, offer, claim, pricing };
}

/**
 * When the appointment a claim was spent on actually is — read back rather
 * than remembered, so a booking the shop has since moved tells the customer
 * the time it was moved to.
 *
 * Returns null for anything that is no longer ahead of them: a cancelled or
 * completed booking must not be shown as something to turn up for.
 */
async function appointmentWhenLabelFor(appointmentId: string, timezone: string): Promise<string | null> {
  const [appointment] = await db()
    .select({
      status: schema.appointments.status,
      startsAt: schema.appointments.startsAt,
      timeToBeConfirmed: schema.appointments.timeToBeConfirmed,
    })
    .from(schema.appointments)
    .where(eq(schema.appointments.id, appointmentId))
    .limit(1);
  if (!appointment) return null;
  if (appointment.status === "cancelled" || appointment.status === "no_show") return null;
  if (appointment.startsAt.getTime() <= Date.now()) return null;
  return appointmentWhenLabel(appointment, timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** The pricing category the two sizes on the offer form stand for. */
function categoryFor(vehicleSize: string): VehicleCategory {
  return vehicleSize === "suv" ? "suv_small" : "sedan";
}

/** The public base URL, falling back to the offer path if it is unconfigured. */
function safeBaseUrl(): string {
  try {
    return getAppBaseUrl();
  } catch {
    return "";
  }
}
