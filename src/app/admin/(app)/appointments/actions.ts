"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import type { AppointmentStatus } from "@/lib/types";
import { VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import { getSettings } from "@/lib/settings";
import { getAvailableSlots } from "@/lib/booking/availability";
import { BookingError, createStaffAppointment } from "@/lib/booking/create";
import { rescheduleAppointment } from "@/lib/booking/reschedule";
import { priceBooking, PricingError } from "@/lib/pricing";
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

const manualSelectionSchema = z.object({
  customerId: z.string().min(1),
  vehicleId: z.string().min(1),
  serviceIds: z.array(z.string().min(1)).min(1).max(5),
  addonIds: z.array(z.string().min(1)).max(10),
});

const manualSlotsSchema = manualSelectionSchema.extend({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const createManualSchema = manualSlotsSchema.extend({
  startMs: z.number().int().positive(),
  customerNotes: z.string().trim().max(2000).optional(),
});

const rescheduleSchema = z.object({
  appointmentId: z.string().min(1),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMs: z.number().int().positive(),
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
    if (!parsed.success) return { ok: false, error: "Select a customer, vehicle, service and date" };
    const input = parsed.data;
    const vehicle = await loadOwnedVehicle(input.customerId, input.vehicleId);
    const settings = await getSettings();
    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
      vehicleCategory: vehicle.category as VehicleCategory,
      settings,
    });
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
    const result = await createStaffAppointment({ ...parsed.data, settings, staffId: staff.id });
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
  method: z.enum(["cash", "etransfer", "card_terminal"]),
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
