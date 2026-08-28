"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import type { AppointmentStatus } from "@/lib/types";
import {
  MANUAL_PAYMENT_METHODS,
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_LABELS,
  type VehicleCategory,
} from "@/lib/types";
import { getSettings } from "@/lib/settings";
import { getAvailableSlots } from "@/lib/booking/availability";
import { BookingError, createStaffAppointment } from "@/lib/booking/create";
import { rescheduleAppointment } from "@/lib/booking/reschedule";
import {
  isRevisableAppointmentStatus,
  reviseAppointmentLines,
  type ReviseDiscountMode,
  type ReviseOutcome,
} from "@/lib/booking/revise";
import { isJobOpenForRepricing } from "@/lib/job-status";
import { notifyStaffOfNewAppointment } from "@/lib/staff-notifications";
import { priceBooking, PricingError } from "@/lib/pricing";
import { resolveActivePromotion } from "@/lib/promotions";
import { formatInZone } from "@/lib/tz";

/** Legal appointment status transitions (staff-driven). */
const TRANSITIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  // A deposit-required appointment is confirmed only by the dedicated,
  // ledger-backed deposit action below.
  deposit_required: ["cancelled"],
  confirmed: ["arrived", "cancelled", "no_show"],
  arrived: ["completed", "converted"],
};

const input = z.object({
  appointmentId: z.string().min(1),
  to: z.enum(["confirmed", "arrived", "cancelled", "no_show", "completed"]),
  reason: z.string().trim().max(1000).optional(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export type AppointmentSlotsResult =
  | { ok: true; slots: Array<{ startMs: number; label: string }>; totalCents?: number; durationMin: number }
  | { ok: false; error: string };

/**
 * A line the catalog cannot price — ceramic coating, paint correction, or any
 * other quote-only job. The price is typed by staff rather than looked up, so
 * this only ever reaches priceBooking from behind the manage_bookings check
 * below; the public booking actions never pass custom lines.
 *
 * Duration is per line because the scheduler books real chair time against it:
 * a coating that takes a day must block the bay for a day.
 */
const customLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  priceCents: z.number().int().min(0).max(10_000_000),
  durationMin: z.number().int().min(0).max(24 * 60),
});

const manualSelectionShape = z.object({
  customerId: z.string().min(1),
  vehicleId: z.string().min(1),
  // No longer `.min(1)`: a booking can be entirely custom work.
  serviceIds: z.array(z.string().min(1)).max(5),
  addonIds: z.array(z.string().min(1)).max(10),
  customLines: z.array(customLineSchema).max(10).default([]),
});

const manualSlotsShape = manualSelectionShape.extend({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * Offer slots that break the minimum-notice / booking-window rules so staff
   * can record walk-ins and same-day work. Only reachable behind
   * manage_bookings; bay and staff conflicts are still enforced.
   */
  allowOutsideBookingWindow: z.boolean().optional(),
});

const createManualShape = manualSlotsShape.extend({
  startMs: z.number().int().positive(),
  customerNotes: z.string().trim().max(2000).optional(),
});

/** Something has to be booked — a catalog service or a custom line. */
function hasBookableLine(value: { serviceIds: string[]; customLines: unknown[] }): boolean {
  return value.serviceIds.length + value.customLines.length > 0;
}

const manualSlotsSchema = manualSlotsShape.refine(hasBookableLine);
const createManualSchema = createManualShape.refine(hasBookableLine);

const rescheduleSchema = z.object({
  appointmentId: z.string().min(1),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMs: z.number().int().positive(),
  allowOutsideBookingWindow: z.boolean().optional(),
});

const rescheduleSlotsSchema = rescheduleSchema.omit({ startMs: true });

async function loadOwnedVehicle(customerId: string, vehicleId: string) {
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, vehicleId)).limit(1);
  if (!vehicle || vehicle.customerId !== customerId) throw new BookingError("Vehicle does not belong to this customer");
  if (!VEHICLE_CATEGORIES.includes(vehicle.category as VehicleCategory)) throw new BookingError("Vehicle category is invalid");
  return vehicle;
}

async function loadAppointmentRequiredSkills(appointmentId: string): Promise<string[]> {
  const lines = await db().select({ serviceId: schema.appointmentServices.serviceId })
    .from(schema.appointmentServices).where(eq(schema.appointmentServices.appointmentId, appointmentId));
  const serviceIds = [...new Set(lines.flatMap((line) => line.serviceId ? [line.serviceId] : []))];
  if (serviceIds.length === 0) return [];
  const services = await db().select({ requiredSkills: schema.services.requiredSkills })
    .from(schema.services).where(inArray(schema.services.id, serviceIds));
  return [...new Set(services.flatMap((service) => service.requiredSkills))];
}

/** Advisory real-slot lookup for the staff manual-booking form. */
export async function getManualAppointmentSlotsAction(raw: unknown): Promise<AppointmentSlotsResult> {
  try {
    await requireStaff("manage_bookings");
    const parsed = manualSlotsSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Select a customer, vehicle, date, and at least one service or custom line" };
    }
    const input = parsed.data;
    const vehicle = await loadOwnedVehicle(input.customerId, input.vehicleId);
    const settings = await getSettings();
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      customLines: input.customLines,
      vehicleCategory: vehicle.category as VehicleCategory,
      settings,
    });
    // A booking of no length would reserve nothing and hand the bay to the next
    // person. Reachable only from an all-custom cart, where staff set the time.
    if (pricing.durationMin <= 0) {
      return { ok: false, error: "Give the work a duration in minutes before checking availability" };
    }
    const slots = await getAvailableSlots({
      dateISO: input.dateISO,
      workDurationMin: pricing.durationMin,
      settings,
      requiredSkills: pricing.requiredSkills,
      allowOutsideBookingWindow: input.allowOutsideBookingWindow,
    });
    return {
      ok: true,
      totalCents: pricing.totalCents,
      durationMin: pricing.durationMin,
      slots: slots.map((slot) => ({
        startMs: slot.start,
        label: formatInZone(new Date(slot.start), settings.timezone, { hour: "numeric", minute: "2-digit" }),
      })),
    };
  } catch (err) {
    if (err instanceof AuthError || err instanceof BookingError || err instanceof PricingError) {
      return { ok: false, error: err.message };
    }
    console.error("getManualAppointmentSlotsAction failed", err);
    return { ok: false, error: "Could not load availability" };
  }
}

export async function createManualAppointmentAction(
  raw: unknown,
): Promise<{ ok: true; appointmentId: string } | { ok: false; error: string }> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = createManualSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the appointment details" };
    const settings = await getSettings();
    // Re-checked here as well as in the slot lookup: this action is the one
    // that writes, and it is reachable without ever calling the other.
    if (parsed.data.serviceIds.length === 0 && parsed.data.customLines.every((line) => line.durationMin <= 0)) {
      return { ok: false, error: "Give the work a duration in minutes" };
    }
    const result = await createStaffAppointment({ ...parsed.data, settings, staffId: staff.id });
    // Best-effort: the booking is already committed, so an alert failure must
    // not surface as a failed appointment creation.
    try {
      await notifyStaffOfNewAppointment(result.appointmentId);
    } catch {
      console.error("Manual appointment created but staff alert could not be queued");
    }
    revalidatePath("/admin/appointments");
    revalidatePath(`/admin/appointments/${result.appointmentId}`);
    return { ok: true, appointmentId: result.appointmentId };
  } catch (err) {
    if (err instanceof AuthError || err instanceof BookingError || err instanceof PricingError) {
      return { ok: false, error: err.message };
    }
    console.error("createManualAppointmentAction failed", err);
    return { ok: false, error: "Something went wrong creating the appointment" };
  }
}

/** Advisory slots excluding the appointment's current capacity reservation. */
export async function getRescheduleSlotsAction(raw: unknown): Promise<AppointmentSlotsResult> {
  try {
    await requireStaff("manage_bookings");
    const parsed = rescheduleSlotsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose a valid date" };
    const [appointment] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, parsed.data.appointmentId)).limit(1);
    if (!appointment) return { ok: false, error: "Appointment not found" };
    if (!["pending", "deposit_required", "confirmed"].includes(appointment.status)) {
      return { ok: false, error: `A ${appointment.status.replaceAll("_", " ")} appointment cannot be rescheduled` };
    }
    const settings = await getSettings();
    const requiredSkills = await loadAppointmentRequiredSkills(appointment.id);
    const slots = await getAvailableSlots({
      dateISO: parsed.data.dateISO,
      workDurationMin: appointment.durationMin,
      settings,
      excludeAppointmentId: appointment.id,
      requiredSkills,
      allowOutsideBookingWindow: parsed.data.allowOutsideBookingWindow,
    });
    return {
      ok: true,
      durationMin: appointment.durationMin,
      slots: slots.map((slot) => ({
        startMs: slot.start,
        label: formatInZone(new Date(slot.start), settings.timezone, { hour: "numeric", minute: "2-digit" }),
      })),
    };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("getRescheduleSlotsAction failed", err);
    return { ok: false, error: "Could not load availability" };
  }
}

export async function rescheduleAppointmentAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = rescheduleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose a valid date and time" };
    const settings = await getSettings();
    await rescheduleAppointment({ ...parsed.data, settings, staffId: staff.id });
    revalidatePath("/admin/appointments");
    revalidatePath(`/admin/appointments/${parsed.data.appointmentId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError || err instanceof BookingError) return { ok: false, error: err.message };
    console.error("rescheduleAppointmentAction failed", err);
    return { ok: false, error: "Something went wrong rescheduling the appointment" };
  }
}

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/);

const depositInput = z.object({
  appointmentId: z.string().min(1),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  amountCents: z.number().int().min(1).max(10_000_000),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Records the exact outstanding appointment deposit and confirms the booking
 * in the same transaction. A client-generated idempotency key makes an
 * ambiguous network retry return success without recording the money twice.
 */
export async function recordAppointmentDepositAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("record_payments");
    const parsed = depositInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid deposit request" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const rows = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, input.appointmentId))
        .for("update");
      const appointment = rows[0];
      if (!appointment) return { ok: false, error: "Appointment not found" };

      const existing = (
        await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.idempotencyKey, input.idempotencyKey))
          .limit(1)
      )[0];
      if (existing) {
        const sameOperation =
          existing.appointmentId === appointment.id &&
          existing.invoiceId === null &&
          existing.customerId === appointment.customerId &&
          existing.kind === "deposit" &&
          existing.provider === input.method &&
          existing.amountCents === input.amountCents &&
          existing.status === "succeeded";
        return sameOperation
          ? { ok: true }
          : { ok: false, error: "That idempotency key was already used for a different payment" };
      }

      if (appointment.status !== "deposit_required") {
        return { ok: false, error: "This appointment is not awaiting a deposit" };
      }
      const remainingCents = Math.max(0, appointment.depositRequiredCents - appointment.depositPaidCents);
      if (remainingCents <= 0) return { ok: false, error: "This deposit is already paid" };
      if (input.amountCents !== remainingCents) {
        return { ok: false, error: `The remaining deposit is ${(remainingCents / 100).toFixed(2)} CAD` };
      }

      const paymentId = newId("pay");
      await tx.insert(schema.payments).values({
        id: paymentId,
        appointmentId: appointment.id,
        customerId: appointment.customerId,
        provider: input.method,
        idempotencyKey: input.idempotencyKey,
        kind: "deposit",
        amountCents: input.amountCents,
        status: "succeeded",
        receivedAt: new Date(),
        recordedByStaffId: staff.id,
      });
      await tx
        .update(schema.appointments)
        .set({
          depositPaidCents: appointment.depositPaidCents + input.amountCents,
          status: "confirmed",
          updatedAt: new Date(),
        })
        .where(eq(schema.appointments.id, appointment.id));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "appointment.deposit_recorded",
        entityType: "appointment",
        entityId: appointment.id,
        before: { status: appointment.status, depositPaidCents: appointment.depositPaidCents },
        after: {
          status: "confirmed",
          depositPaidCents: appointment.depositPaidCents + input.amountCents,
          paymentId,
          method: input.method,
          amountCents: input.amountCents,
        },
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/appointments");
      revalidatePath(`/admin/appointments/${input.appointmentId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("recordAppointmentDepositAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function transitionAppointmentAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { appointmentId, to, reason } = parsed.data;

    return await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointmentId))
        .for("update");
      const appt = rows[0];
      if (!appt) return { ok: false, error: "Appointment not found" };

      const allowed = TRANSITIONS[appt.status as AppointmentStatus] ?? [];
      if (!allowed.includes(to)) {
        return { ok: false, error: `Cannot move a ${appt.status} appointment to ${to}` };
      }
      if (to === "cancelled" && !reason?.trim()) {
        return { ok: false, error: "A cancellation reason is required" };
      }

      await tx
        .update(schema.appointments)
        .set({
          status: to,
          updatedAt: new Date(),
          ...(to === "cancelled"
            ? { cancelledAt: new Date(), cancelledBy: staff.id, cancellationReason: reason }
            : {}),
        })
        .where(eq(schema.appointments.id, appointmentId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: `appointment.${to}`,
        entityType: "appointment",
        entityId: appointmentId,
        before: { status: appt.status },
        after: { status: to },
        reason,
      });
      revalidatePath("/admin/appointments");
      revalidatePath(`/admin/appointments/${appointmentId}`);
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("transitionAppointmentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Counter revision: the customer changed package after booking        */
/* ------------------------------------------------------------------ */

const reviseSchema = manualSelectionShape
  .omit({ customerId: true, vehicleId: true })
  .extend({
    appointmentId: z.string().min(1),
    /**
     * What to do with a promotional discount locked at booking:
     * re-apply the offer to the new package (the default and the honest
     * reading of the ad), keep the original cents as goodwill, or drop it.
     */
    discountMode: z.enum(["reapply", "keep", "remove"]).default("reapply"),
    reason: z.string().trim().min(1).max(500),
    confirmOverlap: z.boolean().optional(),
  })
  .refine(hasBookableLine);

export type ReviseAppointmentResult =
  | { ok: true; warnings: string[]; totalCents: number; depositRefundableCents: number }
  | { ok: false; error: string }
  | { ok: false; needsOverlapConfirm: true; warnings: string[] };

/**
 * Re-prices a booking the customer changed at the counter — an upgrade, a
 * downgrade, or a swap to a different package entirely.
 *
 * Prices through `priceBooking` exactly as booking creation does, so staff pick
 * catalog ids and the server decides the money. The vehicle category is read
 * from the database, never accepted from the form: package prices are
 * size-dependent and a revision has to re-resolve them rather than reuse the
 * old line prices.
 */
export async function reviseAppointmentLinesAction(raw: unknown): Promise<ReviseAppointmentResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = reviseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the revised packages and give a reason" };
    const input = parsed.data;
    const settings = await getSettings();

    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .limit(1);
    if (!appointment) return { ok: false, error: "Appointment not found" };
    const vehicle = await loadOwnedVehicle(appointment.customerId, appointment.vehicleId);

    /**
     * The offer this booking was made under, resolved from the code on the
     * appointment rather than from anything the browser sends.
     *
     * Eligibility is deliberately NOT re-checked. `isFirstTimeDetailCustomer`
     * fails anyone who "already holds an unfulfilled discounted booking" —
     * which this customer now does, because of the very booking being revised.
     * Re-running it would strip the discount from every single revision.
     */
    const promo = resolveActivePromotion(settings, appointment.promoCode);
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      vehicleCategory: vehicle.category as VehicleCategory,
      settings,
      promo,
      customLines: input.customLines,
    });
    if (pricing.durationMin <= 0) return { ok: false, error: "Give the work a duration in minutes" };

    const outcome: ReviseOutcome = await reviseAppointmentLines({
      appointmentId: input.appointmentId,
      lines: pricing.lines,
      reappliedDiscountCents: pricing.discountCents,
      discountMode: input.discountMode as ReviseDiscountMode,
      reason: input.reason,
      staffId: staff.id,
      settings,
      confirmOverlap: input.confirmOverlap,
    });
    if (!outcome.ok) return { ok: false, needsOverlapConfirm: true, warnings: outcome.warnings };

    revalidatePath("/admin/appointments");
    revalidatePath(`/admin/appointments/${input.appointmentId}`);
    revalidatePath("/admin/jobs");
    if (outcome.rebuiltInvoiceId) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/invoices/${outcome.rebuiltInvoiceId}`);
    }
    return {
      ok: true,
      warnings: outcome.warnings,
      totalCents: outcome.totalCents,
      depositRefundableCents: outcome.depositRefundableCents,
    };
  } catch (err) {
    if (err instanceof AuthError || err instanceof BookingError || err instanceof PricingError) {
      return { ok: false, error: err.message };
    }
    console.error("reviseAppointmentLinesAction failed", err);
    return { ok: false, error: "Something went wrong re-pricing the appointment" };
  }
}

/* ------------------------------------------------------------------ */
/* Vehicle on a booking                                                 */
/* ------------------------------------------------------------------ */

const optionalVehicleText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));

const vehicleDetailsSchema = z.object({
  year: z.number().int().min(1900).max(new Date().getFullYear() + 2).optional(),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  trim: optionalVehicleText(60),
  category: z.enum(VEHICLE_CATEGORIES),
  colour: optionalVehicleText(60),
  licencePlate: optionalVehicleText(30),
});

const updateVehicleSchema = z.object({
  appointmentId: z.string().min(1),
  /** The vehicle this booking should point at. Same id = a details-only fix. */
  vehicleId: z.string().min(1),
  /** Corrections to apply to that vehicle before the booking is re-priced. */
  details: vehicleDetailsSchema.optional(),
  confirmOverlap: z.boolean().optional(),
});

export type UpdateAppointmentVehicleResult =
  | { ok: true; repriced: boolean; totalCents: number | null; warnings: string[] }
  | { ok: false; error: string }
  | { ok: false; needsOverlapConfirm: true; warnings: string[] };

/**
 * Why the booking cannot be re-priced right now, phrased for the owner, or null
 * when it can.
 *
 * This mirrors the gate inside reviseAppointmentLines rather than replacing it
 * — the server still re-checks under a row lock. It exists so a vehicle
 * correction on a settled sale is a saved correction plus an explanation,
 * instead of a refusal that leaves "Sedan" on an SUV forever.
 */
async function repricingBlock(appointment: typeof schema.appointments.$inferSelect): Promise<string | null> {
  if (!isRevisableAppointmentStatus(appointment.status)) {
    return `This booking is ${appointment.status.replaceAll("_", " ")}, so its prices cannot be re-calculated.`;
  }
  const [job] = await db()
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.appointmentId, appointment.id))
    .limit(1);
  if (job && !isJobOpenForRepricing(job.status)) {
    return "This job is too far along for its prices to be re-calculated.";
  }
  if (!job?.invoiceId) return null;
  const [invoice] = await db()
    .select({ number: schema.invoices.number, status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, job.invoiceId))
    .limit(1);
  if (invoice && invoice.status !== "draft") {
    return `Invoice #${invoice.number} has already been ${invoice.status.replaceAll("_", " ")}.`;
  }
  return null;
}

/** The booking's current cart, in the shape priceBooking takes. */
async function loadAppointmentSelection(appointmentId: string) {
  const lines = await db()
    .select()
    .from(schema.appointmentServices)
    .where(eq(schema.appointmentServices.appointmentId, appointmentId))
    .orderBy(schema.appointmentServices.sort);
  return {
    serviceIds: lines.flatMap((line) => (line.serviceId ? [line.serviceId] : [])),
    addonIds: lines.flatMap((line) => (line.addonId ? [line.addonId] : [])),
    // Hand-priced work carries forward untouched: a coating quoted at the
    // counter does not cost more because the car turned out to be an SUV.
    customLines: lines
      .filter((line) => !line.serviceId && !line.addonId)
      .map((line) => ({
        description: line.description,
        priceCents: line.priceCents,
        durationMin: line.durationMin,
      })),
  };
}

function categoryLabel(category: string): string {
  return VEHICLE_CATEGORY_LABELS[category as VehicleCategory] ?? category;
}

/**
 * Corrects the vehicle on a booking, and re-prices the packages for its size.
 *
 * The online booking form asks the customer to pick their own vehicle size, and
 * customers get it wrong — a large SUV booked as a sedan is priced as a sedan,
 * because package prices come from `service_vehicle_adjustments` keyed on that
 * category. Until now the only fix was to edit the vehicle on the customer
 * record, which corrected the CRM and left the booking priced at the old size.
 *
 * So this does both halves: the vehicle row is corrected (or the booking is
 * pointed at a different one of the customer's cars), and if that changes the
 * PRICING SIZE the same package selection is re-priced through the counter
 * revision path. What the customer chose is not touched — only what it costs.
 * Changing WHICH packages are on the booking is still "Change packages".
 *
 * Ordering matters: the re-price runs BEFORE the vehicle row is written. The
 * bay-overlap warning is a two-press flow, and if the vehicle were saved on the
 * first press the second press would compare the new size against itself, find
 * nothing changed, and skip the re-pricing the owner was confirming.
 */
export async function updateAppointmentVehicleAction(
  raw: unknown,
): Promise<UpdateAppointmentVehicleResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = updateVehicleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the vehicle details" };
    const input = parsed.data;

    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .limit(1);
    if (!appointment) return { ok: false, error: "Appointment not found" };

    const currentVehicle = await loadOwnedVehicle(appointment.customerId, appointment.vehicleId);
    // Ownership is re-checked for the target too: a vehicle id from the form
    // must belong to this booking's customer, never to somebody else's.
    const targetVehicle =
      input.vehicleId === appointment.vehicleId
        ? currentVehicle
        : await loadOwnedVehicle(appointment.customerId, input.vehicleId);

    const newCategory = (input.details?.category ?? targetVehicle.category) as VehicleCategory;
    const oldCategory = currentVehicle.category;
    const warnings: string[] = [];
    let repriced = false;
    let totalCents: number | null = null;

    if (newCategory !== oldCategory) {
      const block = await repricingBlock(appointment);
      if (block) {
        warnings.push(
          `${block} The vehicle is saved, but the prices on this booking were left as they are.`,
        );
      } else {
        const settings = await getSettings();
        const selection = await loadAppointmentSelection(input.appointmentId);
        const reason = `Vehicle size corrected from ${categoryLabel(oldCategory)} to ${categoryLabel(newCategory)}`;
        try {
          // Eligibility is deliberately not re-checked, for the same reason
          // reviseAppointmentLinesAction does not: see its note.
          const promo = resolveActivePromotion(settings, appointment.promoCode);
          const pricing = await priceBooking({
            ...selection,
            vehicleCategory: newCategory,
            settings,
            promo,
          });
          const outcome: ReviseOutcome = await reviseAppointmentLines({
            appointmentId: input.appointmentId,
            lines: pricing.lines,
            reappliedDiscountCents: pricing.discountCents,
            // "reapply" is the honest reading of an offer against a corrected
            // price — the same default the revise panel documents. Keeping the
            // original cents on a size correction would be a goodwill decision,
            // and that belongs on "Change packages" where it is spelled out.
            discountMode: "reapply",
            reason,
            staffId: staff.id,
            settings,
            confirmOverlap: input.confirmOverlap,
          });
          if (!outcome.ok) {
            // Nothing has been written yet, so the owner can still back out.
            return { ok: false, needsOverlapConfirm: true, warnings: outcome.warnings };
          }
          repriced = true;
          totalCents = outcome.totalCents;
          warnings.push(...outcome.warnings);
        } catch (err) {
          // A retired package or an unavailable add-on cannot be re-priced.
          // That must not block the correction: the vehicle really is an SUV
          // whether or not the catalog can still quote what was sold.
          if (err instanceof BookingError || err instanceof PricingError) {
            warnings.push(
              `${err.message} The vehicle is saved, but the prices on this booking were left as they are.`,
            );
          } else {
            throw err;
          }
        }
      }
    }

    const movedVehicle = targetVehicle.id !== appointment.vehicleId;
    await db().transaction(async (tx) => {
      if (input.details) {
        await tx
          .update(schema.vehicles)
          .set({
            year: input.details.year ?? null,
            make: input.details.make,
            model: input.details.model,
            trim: input.details.trim ?? null,
            category: input.details.category,
            colour: input.details.colour ?? null,
            licencePlate: input.details.licencePlate ?? null,
            updatedAt: new Date(),
          })
          .where(eq(schema.vehicles.id, targetVehicle.id));
      }

      if (movedVehicle) {
        await tx
          .update(schema.appointments)
          .set({ vehicleId: targetVehicle.id, updatedAt: new Date() })
          .where(eq(schema.appointments.id, appointment.id));
        // The job and its draft invoice name the same car. Left behind they
        // would keep pointing at the vehicle the booking no longer uses, and
        // the invoice would go out describing a car that was never here.
        await tx
          .update(schema.jobs)
          .set({ vehicleId: targetVehicle.id, updatedAt: new Date() })
          .where(eq(schema.jobs.appointmentId, appointment.id));
        const [job] = await tx
          .select({ invoiceId: schema.jobs.invoiceId })
          .from(schema.jobs)
          .where(eq(schema.jobs.appointmentId, appointment.id))
          .limit(1);
        if (job?.invoiceId) {
          // Draft only. A sent or paid invoice is a document the customer has
          // seen; correcting it is a credit note, not an edit (DECISIONS.md §21).
          await tx
            .update(schema.invoices)
            .set({ vehicleId: targetVehicle.id, updatedAt: new Date() })
            .where(and(eq(schema.invoices.id, job.invoiceId), eq(schema.invoices.status, "draft")));
        }
      }

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "appointment.vehicle_updated",
        entityType: "appointment",
        entityId: appointment.id,
        before: {
          vehicleId: appointment.vehicleId,
          category: oldCategory,
          make: currentVehicle.make,
          model: currentVehicle.model,
          year: currentVehicle.year,
        },
        after: {
          vehicleId: targetVehicle.id,
          category: newCategory,
          make: input.details?.make ?? targetVehicle.make,
          model: input.details?.model ?? targetVehicle.model,
          year: input.details?.year ?? targetVehicle.year,
          repriced,
          totalCents,
        },
      });
    });

    revalidatePath("/admin/appointments");
    revalidatePath(`/admin/appointments/${input.appointmentId}`);
    revalidatePath(`/admin/customers/${appointment.customerId}`);
    if (repriced || movedVehicle) {
      revalidatePath("/admin/jobs");
      revalidatePath("/admin/invoices");
    }
    return { ok: true, repriced, totalCents, warnings };
  } catch (err) {
    if (err instanceof AuthError || err instanceof BookingError || err instanceof PricingError) {
      return { ok: false, error: err.message };
    }
    console.error("updateAppointmentVehicleAction failed", err);
    return { ok: false, error: "Something went wrong updating the vehicle" };
  }
}

const depositRefundInput = z.object({
  appointmentId: z.string().min(1),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  amountCents: z.number().int().min(1).max(10_000_000),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Returns deposit a downgraded booking can no longer absorb.
 *
 * Deliberately NOT routed through `issueRefundAction`. A deposit payment row
 * carries `appointment_id` with a null `invoice_id`, and reaches the invoice
 * only through the `depositAppliedCents` term inside `summarizePayments`. A
 * refund row written against the *invoice* would therefore push
 * `netPaidCents` below the total and flip a fully-settled invoice back to
 * `partially_paid` — chasing the customer for money they do not owe. The
 * refund belongs against the appointment, which is where the deposit lives.
 */
export async function refundAppointmentDepositAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("issue_refunds");
    const parsed = depositRefundInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A method, amount and reason are required" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [appointment] = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, input.appointmentId))
        .for("update");
      if (!appointment) return { ok: false, error: "Appointment not found" };

      const [existing] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing) {
        const sameOperation =
          existing.appointmentId === appointment.id &&
          existing.invoiceId === null &&
          existing.customerId === appointment.customerId &&
          existing.kind === "refund" &&
          existing.provider === input.method &&
          existing.amountCents === input.amountCents &&
          existing.status === "succeeded";
        return sameOperation
          ? { ok: true }
          : { ok: false, error: "That idempotency key was already used for a different refund" };
      }

      if (input.amountCents > appointment.depositPaidCents) {
        return { ok: false, error: "That is more than the deposit held on this appointment" };
      }

      const paymentId = newId("pay");
      await tx.insert(schema.payments).values({
        id: paymentId,
        appointmentId: appointment.id,
        customerId: appointment.customerId,
        provider: input.method,
        idempotencyKey: input.idempotencyKey,
        kind: "refund",
        amountCents: input.amountCents,
        status: "succeeded",
        receivedAt: new Date(),
        recordedByStaffId: staff.id,
      });
      await tx
        .update(schema.appointments)
        .set({
          depositPaidCents: appointment.depositPaidCents - input.amountCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.appointments.id, appointment.id));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "appointment.deposit_refunded",
        entityType: "appointment",
        entityId: appointment.id,
        before: { depositPaidCents: appointment.depositPaidCents },
        after: {
          depositPaidCents: appointment.depositPaidCents - input.amountCents,
          paymentId,
          method: input.method,
          amountCents: input.amountCents,
        },
        reason: input.reason,
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/appointments");
      revalidatePath(`/admin/appointments/${input.appointmentId}`);
      revalidatePath("/admin/jobs");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("refundAppointmentDepositAction failed", err);
    return { ok: false, error: "Something went wrong refunding the deposit" };
  }
}
