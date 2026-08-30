"use server";

import { z } from "zod";
import { db } from "@/db";
import { getSettings } from "@/lib/settings";
import { priceBooking, PricingError } from "@/lib/pricing";
import { isFirstTimeDetailCustomer, resolveActivePromotion } from "@/lib/promotions";
import { getAvailableSlots } from "@/lib/booking/availability";
import { createAppointment, BookingError, OfferChangedError } from "@/lib/booking/create";
import { sendMessageTemplate } from "@/lib/messaging";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { VEHICLE_CATEGORIES, isQuoteOnlyVehicleCategory } from "@/lib/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getAppBaseUrl } from "@/lib/urls";
import { sendAppointmentDepositRequest } from "@/lib/appointment-deposits";
import { notifyStaffOfNewAppointment } from "@/lib/staff-notifications";

const attributionSchema = z
  .object({
    source: z.string().max(100).optional(),
    medium: z.string().max(100).optional(),
    campaign: z.string().max(200).optional(),
    ad: z.string().max(200).optional(),
    keyword: z.string().max(200).optional(),
    landingPage: z.string().max(500).optional(),
    referrer: z.string().max(1000).optional(),
    utm: z.record(z.string(), z.string().max(500)).optional(),
    gclid: z.string().max(200).optional(),
    fbclid: z.string().max(200).optional(),
    firstTouch: z.record(z.string(), z.string().max(500)).optional(),
    lastTouch: z.record(z.string(), z.string().max(500)).optional(),
    // Unknown keys are stripped by this schema, so the ad offer has to be
    // declared here or it never reaches the server.
    offerCode: z.string().max(64).optional(),
    offerCapturedAt: z.string().max(40).optional(),
  })
  .optional();

/**
 * The public booking flow refuses a quote-only vehicle category outright. The
 * wizard already blocks it, but this is the rule and the wizard is only the UI:
 * a hand-built request must not be able to buy a commercial job at the sedan
 * price plus a delta. Staff booking and invoicing are unaffected — they price
 * commercial work by hand, which is the whole point.
 */
const QUOTE_ONLY_VEHICLE_MESSAGE =
  "Commercial vehicles are quoted individually. Please request a quote and we will come back with a price and a time.";

const slotsInputSchema = z.object({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  serviceIds: z.array(z.string()).min(1).max(5),
  addonIds: z.array(z.string()).max(10),
  vehicleCategory: z.enum(VEHICLE_CATEGORIES),
});

export type SlotsResult =
  | { ok: true; slots: { startMs: number; label: string }[]; totalCents: number; durationMin: number }
  | { ok: false; error: string };

export async function getSlotsAction(raw: unknown): Promise<SlotsResult> {
  const rate = await consumeRateLimit("booking-slots", { limit: 60, windowMs: 5 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many availability requests. Please wait a moment." };
  const parsed = slotsInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const input = parsed.data;
  if (isQuoteOnlyVehicleCategory(input.vehicleCategory)) return { ok: false, error: QUOTE_ONLY_VEHICLE_MESSAGE };
  try {
    const settings = await getSettings();
    const pricing = await priceBooking({ ...input, settings });
    const slots = await getAvailableSlots({
      dateISO: input.dateISO,
      workDurationMin: pricing.durationMin,
      settings,
      requiredSkills: pricing.requiredSkills,
    });
    return {
      ok: true,
      totalCents: pricing.totalCents,
      durationMin: pricing.durationMin,
      slots: slots.map((s) => ({
        startMs: s.start,
        label: formatInZone(new Date(s.start), settings.timezone, {
          hour: "numeric",
          minute: "2-digit",
        }),
      })),
    };
  } catch (err) {
    if (err instanceof PricingError) return { ok: false, error: err.message };
    console.error("getSlotsAction failed", err);
    return { ok: false, error: "Could not load availability. Please try again." };
  }
}

const bookingInputSchema = z.object({
  serviceIds: z.array(z.string()).min(1).max(5),
  addonIds: z.array(z.string()).max(10),
  vehicleCategory: z.enum(VEHICLE_CATEGORIES),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMs: z.number().int().positive(),
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
    phone: z.string().trim().min(7).max(30).optional().or(z.literal("").transform(() => undefined)),
    preferredContact: z.enum(["email", "sms", "phone"]).default("email"),
  }),
  vehicle: z.object({
    year: z.coerce.number().int().min(1950).max(2030).optional(),
    make: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(60),
    category: z.enum(VEHICLE_CATEGORIES),
    colour: z.string().trim().max(40).optional(),
  }),
  customerNotes: z.string().trim().max(2000).optional(),
  policiesAccepted: z.literal(true),
  attribution: attributionSchema,
  /** Offer the browser claims to have arrived on. Validated server-side. */
  promoCode: z.string().trim().max(64).optional(),
  /**
   * What the customer was shown. If the server computes anything else the
   * booking is refused rather than silently repriced.
   */
  expectedDiscountCents: z.number().int().min(0).max(10_000_000).optional(),
});

export type BookingResult =
  | {
      ok: true;
      appointmentId: string;
      status: string;
      whenLabel: string;
      totalLabel: string;
      depositLabel: string | null;
      depositUrl: string | null;
      confirmationDelivery: "email" | "sms" | null;
    }
  | {
      /**
       * The offer no longer applies. Nothing was booked — the wizard shows the
       * corrected total and the customer confirms again.
       */
      ok: false;
      kind: "offer_changed";
      error: string;
      totals: {
        subtotalCents: number;
        discountCents: number;
        taxCents: number;
        totalCents: number;
      };
    }
  | { ok: false; kind?: undefined; error: string };

export async function submitBookingAction(raw: unknown): Promise<BookingResult> {
  const rate = await consumeRateLimit("booking-submit", { limit: 5, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many booking attempts. Please try again later or call us." };
  const parsed = bookingInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please check the form — some fields are missing or invalid." };
  }
  const input = parsed.data;
  if (isQuoteOnlyVehicleCategory(input.vehicleCategory)) return { ok: false, error: QUOTE_ONLY_VEHICLE_MESSAGE };
  try {
    const settings = await getSettings();
    // Server-side authority: recompute price/duration; never trust the client.
    // The browser supplies only a claimed offer code — the percentage, the
    // eligible services and the resulting cents all come from settings.
    const claimed = input.promoCode ?? input.attribution?.offerCode;
    let promo = resolveActivePromotion(settings, claimed);
    if (promo?.firstTimeOnly && !(await isFirstTimeDetailCustomer(db(), input.customer, promo.eligibleServiceIds))) {
      promo = null;
    }
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      vehicleCategory: input.vehicleCategory,
      settings,
      promo,
    });

    // The customer must never be charged a total they were not shown. If the
    // offer moved between page load and submit, stop and re-confirm.
    if (
      input.expectedDiscountCents !== undefined &&
      input.expectedDiscountCents !== pricing.discountCents
    ) {
      return {
        ok: false,
        kind: "offer_changed",
        error:
          pricing.discountCents === 0
            ? "This offer does not apply to this booking — it is for first-time detailing customers. Please review the updated total."
            : "The offer changed while you were booking. Please review the updated total.",
        totals: {
          subtotalCents: pricing.subtotalCents,
          discountCents: pricing.discountCents,
          taxCents: pricing.taxCents,
          totalCents: pricing.totalCents,
        },
      };
    }
    // Validate external-link configuration before committing a booking that
    // requires online confirmation, avoiding an orphaned unpaid reservation.
    const baseUrl = pricing.depositRequiredCents > 0 ? getAppBaseUrl() : null;
    const result = await createAppointment({
      customer: input.customer,
      vehicle: input.vehicle,
      pricing,
      dateISO: input.dateISO,
      startMs: input.startMs,
      customerNotes: input.customerNotes,
      attribution: promo
        ? {
            ...input.attribution,
            promo: {
              code: promo.code,
              label: promo.label,
              percentOffBp: promo.percentOffBp,
              at: new Date().toISOString(),
            },
          }
        : input.attribution,
      policiesAccepted: input.policiesAccepted,
      settings,
      promo,
    });

    const whenLabel = formatInZone(new Date(input.startMs), settings.timezone, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    let depositUrl: string | null = null;
    let delivery: "email" | "sms" | null = null;
    try {
      if (pricing.depositRequiredCents > 0) {
        if (!result.depositAccessToken || !baseUrl) {
          throw new Error("Deposit-required booking did not create an access token");
        }
        depositUrl = `${baseUrl}/portal/deposits/${result.depositAccessToken}`;
        const request = await sendAppointmentDepositRequest(result.appointmentId, depositUrl);
        delivery = request.sent ? (request.channel ?? null) : null;
      } else {
        // Only deposit-free bookings are confirmed immediately. Deposit-backed
        // bookings receive their confirmation after payment succeeds.
        const confirmation = await sendMessageTemplate({
          templateKey: "booking_confirmation",
          recipient: input.customer,
          customerId: result.customerId,
          kind: "confirmation",
          variables: {
            businessName: settings.businessName,
            firstName: input.customer.firstName,
            date: whenLabel,
            time: "",
            services: pricing.lines.map((l) => l.description).join(", "),
            vehicle: `${input.vehicle.make} ${input.vehicle.model}`,
            // Empty when no offer applied, so the template renders cleanly
            // either way — same idiom as {{balanceLine}} on receipts.
            discountLine:
              pricing.discountCents > 0
                ? `${pricing.promoLabel}: -${formatCents(pricing.discountCents)}\n`
                : "",
            total: formatCents(pricing.totalCents),
          },
          relatedEntityType: "appointment",
          relatedEntityId: result.appointmentId,
        });
        delivery = confirmation.sent ? (confirmation.channel ?? null) : null;
      }
    } catch {
      // The secure link remains visible in the success UI even when message
      // delivery is unavailable; a messaging outage must not duplicate a booking.
      console.error("Booking created but customer message could not be queued");
    }

    // Staff alert is independent of the customer message: the owner still wants
    // to know about the booking even if the customer's confirmation bounced.
    try {
      await notifyStaffOfNewAppointment(result.appointmentId);
    } catch {
      console.error("Booking created but staff alert could not be queued");
    }

    return {
      ok: true,
      appointmentId: result.appointmentId,
      status: result.status,
      whenLabel,
      totalLabel: formatCents(pricing.totalCents),
      depositLabel:
        pricing.depositRequiredCents > 0 ? formatCents(pricing.depositRequiredCents) : null,
      depositUrl,
      confirmationDelivery: delivery,
    };
  } catch (err) {
    // Lost the eligibility re-check inside the booking transaction: nothing was
    // written, so re-price without the offer and let the customer confirm the
    // real total.
    if (err instanceof OfferChangedError) {
      try {
        const settings = await getSettings();
        const repriced = await priceBooking({
          serviceIds: input.serviceIds,
          addonIds: input.addonIds,
          vehicleCategory: input.vehicleCategory,
          settings,
        });
        return {
          ok: false,
          kind: "offer_changed",
          error: err.message,
          totals: {
            subtotalCents: repriced.subtotalCents,
            discountCents: repriced.discountCents,
            taxCents: repriced.taxCents,
            totalCents: repriced.totalCents,
          },
        };
      } catch {
        return { ok: false, error: err.message };
      }
    }
    if (err instanceof PricingError || err instanceof BookingError) {
      return { ok: false, error: err.message };
    }
    console.error("submitBookingAction failed", err);
    return { ok: false, error: "Something went wrong creating your booking. Please try again." };
  }
}
