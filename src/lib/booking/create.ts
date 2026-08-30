import { eq, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { audit } from "@/lib/audit";
import type { BusinessSettings } from "@/lib/settings";
import type { Attribution } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";
import { isDateOnlyBookingSlug } from "@/lib/ceramic";
import { priceBooking, type BookingPricing, type CustomBookingLine } from "@/lib/pricing";
import { isFirstTimeDetailCustomer, type ResolvedPromotion } from "@/lib/promotions";
import { localDateISO } from "@/lib/tz";
import { VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import { createAppointmentDepositAccessToken } from "@/lib/appointment-deposits";
import {
  computeDaySlots,
  loadDayContext,
  pickFreeBay,
  pickFreeStaff,
  type DayContext,
  type Interval,
} from "./availability";

export class BookingError extends Error {}

/**
 * The nominal window stored for a booking that has a date but no agreed time.
 *
 * It starts at that day's opening time purely so the row sits on the right
 * calendar day for every "what is on today" query and every ordering; nothing
 * reads it as a promise (see `appointment-time.ts`), and the availability
 * engine skips the row entirely, so the length overrunning closing time costs
 * nobody a slot.
 *
 * What IS checked is the date itself: the shop must be open, the day must
 * still be ahead, and it must fall inside the booking window. The minimum-
 * notice rule is deliberately expressed as "a later day than today" rather
 * than as hours-from-now — the customer is not claiming a time, so measuring
 * notice to an opening time nobody has agreed to would refuse dates the
 * date picker itself offers.
 */
function dateOnlyWindow(ctx: DayContext, req: BookingRequest): Interval {
  const { openMs, closeMs } = ctx;
  if (openMs === null || closeMs === null) {
    throw new BookingError("We are closed on that date. Please choose another day.");
  }
  // Only a closure covering the whole working day rules the date out. A block
  // over part of it does not: no time has been claimed, so there is nothing
  // for it to collide with.
  if (ctx.globalBlocks.some((block) => block.start <= openMs && block.end >= closeMs)) {
    throw new BookingError("We are closed on that date. Please choose another day.");
  }
  if (!ctx.allowOutsideBookingWindow) {
    if (req.dateISO <= localDateISO(req.settings.timezone, 0, ctx.nowMs)) {
      throw new BookingError("Please choose a date from tomorrow onwards.");
    }
    if (openMs > ctx.nowMs + ctx.maxBookingWindowDays * 86_400_000) {
      throw new BookingError("That date is too far ahead. Please choose an earlier date.");
    }
  }
  return { start: openMs, end: openMs + ctx.totalDurationMin * 60_000 };
}

/**
 * The promotion the customer was shown no longer applies — they became
 * ineligible, or the offer changed between page load and submit.
 *
 * Thrown from inside the booking transaction, so nothing is written: no
 * appointment, no customer, no vehicle. The caller re-prices and asks the
 * customer to confirm the corrected total. A price must never change silently
 * underneath someone.
 */
export class OfferChangedError extends BookingError {
  constructor(readonly reason: "returning" | "expired") {
    super(
      reason === "returning"
        ? "This offer is for first-time customers only, so it does not apply to this booking."
        : "This offer is no longer available.",
    );
  }
}

export type BookingRequest = {
  customer: {
    id?: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    preferredContact?: "email" | "sms" | "phone";
  };
  vehicle: {
    id?: string;
    year?: number;
    make: string;
    model: string;
    category: VehicleCategory;
    colour?: string;
  };
  pricing: BookingPricing;
  dateISO: string;
  /**
   * The chosen start, or `null` to book the DATE and leave the time to the
   * shop. A customer booking a service the shop schedules by hand is always
   * date-only whatever this says — see `createAppointmentInTransaction`.
   */
  startMs: number | null;
  customerNotes?: string;
  attribution?: Attribution;
  policiesAccepted: boolean;
  settings: BusinessSettings;
  /**
   * The promotion priced into `pricing`, so eligibility can be re-checked
   * under the booking lock. Absent means no promotion was applied.
   */
  promo?: ResolvedPromotion | null;
  /**
   * Staff-only: book outside the minimum-notice / maximum-window rules, for
   * walk-ins being recorded after the fact or same-day jobs. Ignored for
   * customer bookings — see the actor check in createAppointmentInTransaction.
   * Double-booking protection is unaffected.
   */
  allowOutsideBookingWindow?: boolean;
};

type BookingActor = { type: "customer" } | { type: "staff"; id: string };

// `select` is needed for the in-transaction promotion eligibility re-check.
type BookingTx = Pick<Db, "execute" | "insert" | "update" | "select">;
type CreatedAppointment = {
  appointmentId: string;
  customerId: string;
  vehicleId: string;
  status: string;
  /** As stored. For a date-only booking this is the day's opening time. */
  startsAt: Date;
  /** True when the shop still owes the customer a time. */
  timeToBeConfirmed: boolean;
  depositAccessToken?: string;
};

/**
 * Creates an appointment with hard double-booking protection.
 *
 * Strategy: inside one transaction, take FOR UPDATE row locks on all active
 * bays. This serializes concurrent booking attempts; the availability window
 * is then re-validated from live data before insert. The advisory slot list
 * shown in the UI is never trusted.
 */
export async function createAppointment(req: BookingRequest): Promise<CreatedAppointment> {
  if (!req.policiesAccepted) throw new BookingError("Policies must be accepted");
  if (!req.customer.email && !req.customer.phone) {
    throw new BookingError("An email address or phone number is required");
  }

  return db().transaction((tx) => createAppointmentInTransaction(tx, req, { type: "customer" }));
}

/**
 * Transaction-aware variant used by staff workflows that must atomically
 * reserve a slot and update their source record (for example estimate
 * conversion). The caller owns the transaction and any source-row lock.
 */
export async function createAppointmentInTransaction(
  tx: BookingTx,
  req: BookingRequest,
  actor: BookingActor,
): Promise<CreatedAppointment> {
  if (actor.type === "customer" && !req.policiesAccepted) {
    throw new BookingError("Policies must be accepted");
  }
  if (actor.type === "customer" && !req.customer.email && !req.customer.phone) {
    throw new BookingError("An email address or phone number is required");
  }

    // Serialize concurrent bookings across the whole schedule.
    await tx.execute(sql`SELECT id FROM resources WHERE type = 'bay' AND active = true ORDER BY id FOR UPDATE`);
    // When weekly schedules are configured, the staff rows are the second
    // capacity lock. All booking paths take resource → staff locks in this order.
    await tx.execute(sql`SELECT id FROM staff_users WHERE active = true ORDER BY id FOR UPDATE`);

    // Re-validate the slot from live data (post-lock). loadDayContext uses the
    // global db() handle, which is safe: the lock above guarantees no
    // concurrent booking transaction can commit between here and our insert.
    // Promotion eligibility, re-checked under the lock above. Those two
    // FOR UPDATE statements serialize every booking transaction, so a second
    // parallel attempt by the same person blocks here and then sees the
    // winner's committed rows — no extra lock or unique index needed.
    // Staff-created bookings are exempt: they carry their own pricing.
    if (
      actor.type === "customer" &&
      req.promo?.firstTimeOnly &&
      req.pricing.discountCents > 0 &&
      !(await isFirstTimeDetailCustomer(tx, req.customer, req.promo.eligibleServiceIds))
    ) {
      // The caller re-prices through priceBooking() rather than adjusting
      // totals here — that stays the one pricing authority.
      throw new OfferChangedError("returning");
    }

    const { ctx, bayIds } = await loadDayContext({
      dateISO: req.dateISO,
      workDurationMin: req.pricing.durationMin,
      settings: req.settings,
      requiredSkills: req.pricing.requiredSkills,
      // Enforced here rather than trusted from the request: a customer-path
      // caller can never relax the notice window, whatever it passes.
      allowOutsideBookingWindow: actor.type === "staff" && req.allowOutsideBookingWindow === true,
    });

    // Whether this booking gets a time is decided by the catalogue, not by the
    // request: a customer booking a service the shop schedules by hand is
    // always date-only however the form was filled in, and a customer booking
    // anything else always owes a real slot — otherwise omitting the field
    // would be a way to skip the availability check entirely. Staff keep the
    // choice, because they ARE the phone call that agrees the time.
    const dateOnly =
      actor.type === "customer"
        ? req.pricing.serviceSlugs.some(isDateOnlyBookingSlug)
        : req.startMs === null;
    if (!dateOnly && req.startMs === null) {
      throw new BookingError("Please choose an appointment time.");
    }

    const window: Interval = dateOnly
      ? dateOnlyWindow(ctx, req)
      : { start: req.startMs!, end: req.startMs! + ctx.totalDurationMin * 60_000 };

    // A date-only booking reserves nothing, so there is no slot to re-validate
    // and no bay or staff member to hold: the shop assigns both by hand when it
    // agrees the time. Everything below this point is the ordinary path.
    let bayIdx: number | null = null;
    let assignedStaffId: string | null | undefined;
    if (!dateOnly) {
      const slots = computeDaySlots(ctx);
      if (!slots.some((s) => s.start === window.start)) {
        throw new BookingError("That time is no longer available. Please choose another slot.");
      }
      bayIdx = pickFreeBay(ctx, window);
      if (bayIdx === null) {
        throw new BookingError("That time is no longer available. Please choose another slot.");
      }
      assignedStaffId = pickFreeStaff(ctx, window);
      if (ctx.staffingConfigured && !assignedStaffId) {
        throw new BookingError("That time is no longer available. Please choose another slot.");
      }
    }

    // Customer: reuse when a known id is given; otherwise create.
    let customerId = req.customer.id ?? null;
    if (!customerId) {
      customerId = newId("cus");
      await tx.insert(schema.customers).values({
        id: customerId,
        firstName: req.customer.firstName,
        lastName: req.customer.lastName,
        email: req.customer.email ?? null,
        phone: req.customer.phone ?? null,
        // Written so staff can find them later. Deliberately NOT read here:
        // matching a public booking to an existing customer by phone number
        // would let a stranger attach to somebody else's record
        // (DECISIONS.md #14). Dedup is a staff-side, human-reviewed job.
        phoneNormalized: normalizePhone(req.customer.phone),
        preferredContact: req.customer.preferredContact ?? "email",
      });
    }

    let vehicleId = req.vehicle.id ?? null;
    if (!vehicleId) {
      vehicleId = newId("veh");
      await tx.insert(schema.vehicles).values({
        id: vehicleId,
        customerId,
        year: req.vehicle.year ?? null,
        make: req.vehicle.make,
        model: req.vehicle.model,
        category: req.vehicle.category,
        colour: req.vehicle.colour ?? null,
      });
    }

    const status = req.pricing.depositRequiredCents > 0 ? "deposit_required" : "confirmed";
    const appointmentId = newId("apt");
    await tx.insert(schema.appointments).values({
      id: appointmentId,
      customerId,
      vehicleId,
      status,
      startsAt: new Date(window.start),
      endsAt: new Date(window.end),
      // Null for a date-only booking: nothing is reserved until the shop has
      // agreed a time and rescheduled it onto a real slot.
      resourceId: bayIdx === null ? null : bayIds[bayIdx],
      assignedStaffId: assignedStaffId ?? null,
      timeToBeConfirmed: dateOnly,
      subtotalCents: req.pricing.subtotalCents,
      discountCents: req.pricing.discountCents,
      promoCode: req.pricing.promoCode,
      promoLabel: req.pricing.promoLabel,
      taxCents: req.pricing.taxCents,
      taxRateBp: req.pricing.taxRateBp,
      totalCents: req.pricing.totalCents,
      depositRequiredCents: req.pricing.depositRequiredCents,
      durationMin: req.pricing.durationMin,
      customerNotes: req.customerNotes ?? null,
      attribution: req.attribution ?? null,
      // Staff-created bookings never imply that the customer accepted public
      // website terms. That consent must only come from the customer flow.
      policiesAcceptedAt: actor.type === "customer" && req.policiesAccepted ? new Date() : null,
    });

    await tx.insert(schema.appointmentServices).values(
      req.pricing.lines.map((line, i) => ({
        id: newId("aps"),
        appointmentId,
        serviceId: line.serviceId ?? null,
        addonId: line.addonId ?? null,
        description: line.description,
        priceCents: line.priceCents,
        durationMin: line.durationMin,
        sort: i,
      })),
    );

    await audit(tx, {
      actorType: actor.type,
      actorId: actor.type === "staff" ? actor.id : undefined,
      action: "appointment.created",
      entityType: "appointment",
      entityId: appointmentId,
      after: {
        status,
        startsAt: new Date(window.start).toISOString(),
        endsAt: new Date(window.end).toISOString(),
        timeToBeConfirmed: dateOnly,
        resourceId: bayIdx === null ? null : bayIds[bayIdx],
        assignedStaffId: assignedStaffId ?? null,
        requiredSkills: req.pricing.requiredSkills,
        totalCents: req.pricing.totalCents,
        discountCents: req.pricing.discountCents,
        promoCode: req.pricing.promoCode,
      },
    });

    const depositAccessToken =
      actor.type === "customer" && req.pricing.depositRequiredCents > 0
        ? await createAppointmentDepositAccessToken(tx, {
            appointmentId,
            customerId,
            expiresAt: new Date(Date.now() + 48 * 60 * 60_000),
          })
        : undefined;

    return {
      appointmentId,
      customerId,
      vehicleId,
      status,
      startsAt: new Date(window.start),
      timeToBeConfirmed: dateOnly,
      depositAccessToken,
    };
}

/**
 * Creates a booking for an existing CRM customer/vehicle. Relationship and
 * vehicle category are read from the database; client price/category values
 * are never accepted.
 */
export async function createStaffAppointment(input: {
  customerId: string;
  vehicleId: string;
  serviceIds: string[];
  addonIds: string[];
  /** Hand-priced work with no catalog entry — paint correction, say. */
  customLines?: CustomBookingLine[];
  dateISO: string;
  startMs: number;
  customerNotes?: string;
  settings: BusinessSettings;
  staffId: string;
  /** Record a walk-in that already happened, or book same-day. */
  allowOutsideBookingWindow?: boolean;
}): Promise<{ appointmentId: string; customerId: string; vehicleId: string; status: string }> {
  return db().transaction(async (tx) => {
    const [customer] = await tx
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, input.customerId))
      .for("update");
    if (!customer || customer.anonymizedAt) throw new BookingError("Customer not found");
    const [vehicle] = await tx
      .select()
      .from(schema.vehicles)
      .where(eq(schema.vehicles.id, input.vehicleId))
      .for("update");
    if (!vehicle || vehicle.customerId !== customer.id) {
      throw new BookingError("Vehicle does not belong to this customer");
    }
    if (!VEHICLE_CATEGORIES.includes(vehicle.category as VehicleCategory)) {
      throw new BookingError("Vehicle category is invalid");
    }

    // No `promo` argument: public ad offers never apply to a booking staff
    // take on someone's behalf. Staff discount through the estimate/invoice
    // discount field, which is theirs to set and is separately audited.
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      customLines: input.customLines,
      vehicleCategory: vehicle.category as VehicleCategory,
      settings: input.settings,
    });
    return createAppointmentInTransaction(
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
          id: vehicle.id,
          year: vehicle.year ?? undefined,
          make: vehicle.make,
          model: vehicle.model,
          category: vehicle.category as VehicleCategory,
          colour: vehicle.colour ?? undefined,
        },
        pricing,
        dateISO: input.dateISO,
        startMs: input.startMs,
        customerNotes: input.customerNotes,
        attribution: { source: "manual" },
        policiesAccepted: false,
        settings: input.settings,
        allowOutsideBookingWindow: input.allowOutsideBookingWindow,
      },
      { type: "staff", id: input.staffId },
    );
  });
}
