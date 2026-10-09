import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { BookingError, createAppointmentInTransaction } from "@/lib/booking/create";
import { getAvailableSlots } from "@/lib/booking/availability";
import { PricingError, priceBooking, type BookingPricing } from "@/lib/pricing";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import type { VehicleCategory } from "@/lib/types";
import { MEMBERSHIP_BENEFITS, WINTER_PASS_SERVICE_SLUG, membershipSettings, type MembershipBenefit } from "./config";
import { resolveMemberPricing } from "./pricing";
import { getVehicleEntitlements } from "./service";

/**
 * Booking from the customer account, where the shop knows who the member is
 * — the one place a membership or Winter Pass can be spent online. The public
 * wizard stays anonymous on purpose (DECISIONS #14) and never applies one.
 */

export type MemberVisitRequest = {
  vehicleId: string;
  /** What this visit is for. */
  use: "member" | "pass" | "package";
  /** For "member": which of this month's included services to book. */
  benefits?: MembershipBenefit[];
  /** For "package": one of the discount-eligible detailing packages. */
  packageServiceId?: string;
  addonIds?: string[];
};

export class MemberBookingError extends Error {}

type Resolved = {
  vehicle: typeof schema.vehicles.$inferSelect;
  pricing: BookingPricing;
  settings: BusinessSettings;
  /** The booking window, extended for members (priority booking). */
  bookingSettings: BusinessSettings;
  /** Member benefits must be used inside the month they belong to. */
  mustStartBefore: Date | null;
};

/**
 * Turns a request into a server-side price for this exact car, refusing
 * anything the car is not entitled to. Every number comes from the catalogue
 * and the membership tables, never from the request.
 */
export async function resolveMemberVisit(
  request: MemberVisitRequest,
  allowedCustomerIds: string[],
  at: Date,
): Promise<Resolved> {
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, request.vehicleId)).limit(1);
  if (!vehicle || !allowedCustomerIds.includes(vehicle.customerId)) throw new MemberBookingError("Choose one of your vehicles.");
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const { membership, passes } = await getVehicleEntitlements(vehicle.id, new Date());

  const slugs = new Set<string>([WINTER_PASS_SERVICE_SLUG, ...config.discountServiceSlugs]);
  for (const benefit of Object.values(MEMBERSHIP_BENEFITS)) slugs.add(benefit.serviceSlug);
  const services = await db()
    .select({ id: schema.services.id, slug: schema.services.slug })
    .from(schema.services)
    .where(and(inArray(schema.services.slug, [...slugs]), eq(schema.services.active, true)));
  const idBySlug = new Map(services.map((s) => [s.slug, s.id]));

  const serviceIds: string[] = [];
  let spendBenefits: MembershipBenefit[] = [];
  let spendPassWash = false;
  let mustStartBefore: Date | null = null;
  if (request.use === "member") {
    if (!membership || membership.status !== "active") throw new MemberBookingError("This car doesn't have an active membership.");
    spendBenefits = [...new Set(request.benefits ?? [])].filter((b) => membership.included.includes(b));
    if (spendBenefits.length === 0) throw new MemberBookingError("Choose what you'd like to book.");
    for (const benefit of spendBenefits) {
      if (!membership.available.includes(benefit)) {
        throw new MemberBookingError(`This month's ${MEMBERSHIP_BENEFITS[benefit].label.toLowerCase()} has already been used.`);
      }
      const id = idBySlug.get(MEMBERSHIP_BENEFITS[benefit].serviceSlug);
      if (!id) throw new MemberBookingError("That service isn't available to book right now. Please call us.");
      serviceIds.push(id);
    }
    mustStartBefore = membership.currentPeriodEnd;
  } else if (request.use === "pass") {
    const pass = passes[0];
    if (!pass) throw new MemberBookingError("This car doesn't have a Winter Pass with washes left.");
    const id = idBySlug.get(WINTER_PASS_SERVICE_SLUG);
    if (!id) throw new MemberBookingError("That service isn't available to book right now. Please call us.");
    serviceIds.push(id);
    spendPassWash = true;
    if (at < pass.validFrom) {
      throw new MemberBookingError(
        `Winter Pass washes start on ${formatInZone(pass.validFrom, settings.timezone, { month: "long", day: "numeric" })}.`,
      );
    }
    mustStartBefore = pass.validUntil;
  } else {
    const eligible = config.discountServiceSlugs.map((slug) => idBySlug.get(slug)).filter(Boolean);
    if (!request.packageServiceId || !eligible.includes(request.packageServiceId)) {
      throw new MemberBookingError("Choose a detailing package.");
    }
    serviceIds.push(request.packageServiceId);
  }

  const member = await resolveMemberPricing({ vehicleId: vehicle.id, spendBenefits, spendPassWash, at });
  let pricing: BookingPricing;
  try {
    pricing = await priceBooking({
      serviceIds,
      addonIds: request.addonIds ?? [],
      vehicleCategory: vehicle.category as VehicleCategory,
      settings,
      member,
    });
  } catch (error) {
    if (error instanceof PricingError) throw new MemberBookingError(error.message);
    throw error;
  }
  // Every entitlement asked for must actually have been priced in; otherwise
  // the customer would be booked at full price for a "free" wash.
  const spent = pricing.entitlements ?? [];
  const wantedSpends = spendBenefits.length + (spendPassWash ? 1 : 0);
  if (spent.length < wantedSpends) throw new MemberBookingError("That benefit isn't available on this date.");

  const bookingSettings: BusinessSettings = membership?.status === "active"
    ? { ...settings, maxBookingWindowDays: settings.maxBookingWindowDays + config.priorityBookingExtraDays }
    : settings;
  return { vehicle, pricing, settings, bookingSettings, mustStartBefore };
}

/** Bookable start times for one day, labelled in shop time. */
export async function memberVisitSlots(request: MemberVisitRequest, allowedCustomerIds: string[], dateISO: string) {
  const resolved = await resolveMemberVisit(request, allowedCustomerIds, new Date(`${dateISO}T12:00:00Z`));
  const slots = await getAvailableSlots({
    dateISO,
    workDurationMin: resolved.pricing.durationMin,
    settings: resolved.bookingSettings,
    requiredSkills: resolved.pricing.requiredSkills,
  });
  const usable = resolved.mustStartBefore ? slots.filter((s) => s.start < resolved.mustStartBefore!.getTime()) : slots;
  return {
    pricing: resolved.pricing,
    slots: usable.map((s) => ({
      startMs: s.start,
      label: formatInZone(new Date(s.start), resolved.settings.timezone, { hour: "numeric", minute: "2-digit" }),
    })),
    mustStartBefore: resolved.mustStartBefore,
    maxBookingWindowDays: resolved.bookingSettings.maxBookingWindowDays,
  };
}

/**
 * Books it. The entitlement is spent inside the booking transaction (see
 * createAppointmentInTransaction), so two tabs racing for this month's wash
 * produce one booking.
 */
export async function bookMemberVisit(input: {
  request: MemberVisitRequest;
  allowedCustomerIds: string[];
  dateISO: string;
  startMs: number;
  notes?: string;
}) {
  const resolved = await resolveMemberVisit(input.request, input.allowedCustomerIds, new Date(input.startMs));
  if (resolved.mustStartBefore && input.startMs >= resolved.mustStartBefore.getTime()) {
    throw new MemberBookingError(
      input.request.use === "member"
        ? `This month's benefit has to be used by ${formatInZone(resolved.mustStartBefore, resolved.settings.timezone, { month: "long", day: "numeric" })}. Next month's wash can be booked once that month starts.`
        : "Winter Pass washes have to be used by the end of the season.",
    );
  }
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, resolved.vehicle.customerId)).limit(1);
  if (!customer) throw new MemberBookingError("Choose one of your vehicles.");
  try {
    return await db().transaction((tx) =>
      createAppointmentInTransaction(
        tx,
        {
          customer: {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email ?? undefined,
            phone: customer.phone ?? undefined,
            preferredContact: customer.preferredContact as "email" | "sms" | "phone",
          },
          vehicle: {
            id: resolved.vehicle.id,
            make: resolved.vehicle.make,
            model: resolved.vehicle.model,
            category: resolved.vehicle.category as VehicleCategory,
          },
          pricing: resolved.pricing,
          dateISO: input.dateISO,
          startMs: input.startMs,
          customerNotes: input.notes,
          attribution: { source: "account" },
          policiesAccepted: true,
          settings: resolved.bookingSettings,
        },
        { type: "customer" },
      ),
    );
  } catch (error) {
    if (error instanceof BookingError) throw new MemberBookingError(error.message);
    throw error;
  }
}
