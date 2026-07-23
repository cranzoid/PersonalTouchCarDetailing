"use server";

import { z } from "zod";
import { getSettings } from "@/lib/settings";
import { priceBooking, PricingError } from "@/lib/pricing";
import { getAvailableSlots } from "@/lib/booking/availability";
import { createAppointment, BookingError } from "@/lib/booking/create";
import { sendMessageTemplate } from "@/lib/messaging";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { VEHICLE_CATEGORIES } from "@/lib/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getAppBaseUrl } from "@/lib/urls";
import { sendAppointmentDepositRequest } from "@/lib/appointment-deposits";

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
  })
  .optional();

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
  | { ok: false; error: string };

export async function submitBookingAction(raw: unknown): Promise<BookingResult> {
  const rate = await consumeRateLimit("booking-submit", { limit: 5, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many booking attempts. Please try again later or call us." };
  const parsed = bookingInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please check the form — some fields are missing or invalid." };
  }
  const input = parsed.data;
  try {
    const settings = await getSettings();
    // Server-side authority: recompute price/duration; never trust the client.
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      vehicleCategory: input.vehicleCategory,
      settings,
    });
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
      attribution: input.attribution,
      policiesAccepted: input.policiesAccepted,
      settings,
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
    if (err instanceof PricingError || err instanceof BookingError) {
      return { ok: false, error: err.message };
    }
    console.error("submitBookingAction failed", err);
    return { ok: false, error: "Something went wrong creating your booking. Please try again." };
  }
}
