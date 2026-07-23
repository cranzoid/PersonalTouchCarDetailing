import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { BusinessSettings } from "@/lib/settings";
import { computeDaySlots, loadDayContext, pickFreeBay, pickFreeStaff, type Interval } from "./availability";
import { BookingError } from "./create";

const RESCHEDULABLE = new Set(["pending", "deposit_required", "confirmed"]);

/**
 * Moves an appointment under the same bay lock used by booking creation.
 * Live capacity is re-read after the lock and the appointment is excluded
 * from its own busy interval.
 */
export async function rescheduleAppointment(input: {
  appointmentId: string;
  dateISO: string;
  startMs: number;
  settings: BusinessSettings;
  staffId: string;
}): Promise<{ appointmentId: string; startsAt: Date; endsAt: Date; resourceId: string; status: string }> {
  return db().transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    if (!appointment) throw new BookingError("Appointment not found");
    if (!RESCHEDULABLE.has(appointment.status)) {
      throw new BookingError(`A ${appointment.status.replaceAll("_", " ")} appointment cannot be rescheduled`);
    }

    await tx.execute(sql`SELECT id FROM resources WHERE type = 'bay' AND active = true ORDER BY id FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM staff_users WHERE active = true ORDER BY id FOR UPDATE`);
    const appointmentLines = await tx
      .select({ serviceId: schema.appointmentServices.serviceId })
      .from(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointment.id));
    const serviceIds = [...new Set(appointmentLines.flatMap((line) => line.serviceId ? [line.serviceId] : []))];
    const serviceRows = serviceIds.length > 0
      ? await tx.select({ requiredSkills: schema.services.requiredSkills }).from(schema.services)
          .where(inArray(schema.services.id, serviceIds))
      : [];
    const requiredSkills = [...new Set(serviceRows.flatMap((service) => service.requiredSkills))];
    const { ctx, bayIds } = await loadDayContext({
      dateISO: input.dateISO,
      workDurationMin: appointment.durationMin,
      settings: input.settings,
      excludeAppointmentId: appointment.id,
      requiredSkills,
    });
    const window: Interval = {
      start: input.startMs,
      end: input.startMs + ctx.totalDurationMin * 60_000,
    };
    if (!computeDaySlots(ctx).some((slot) => slot.start === window.start)) {
      throw new BookingError("That time is no longer available. Please choose another slot.");
    }
    const bayIdx = pickFreeBay(ctx, window);
    if (bayIdx === null || !bayIds[bayIdx]) {
      throw new BookingError("That time is no longer available. Please choose another slot.");
    }
    const eligibleStaffId = pickFreeStaff(ctx, window);
    if (ctx.staffingConfigured && !eligibleStaffId) {
      throw new BookingError("That time is no longer available. Please choose another slot.");
    }

    const startsAt = new Date(window.start);
    const endsAt = new Date(window.end);
    const resourceId = bayIds[bayIdx];
    await tx
      .update(schema.appointments)
      .set({
        startsAt,
        endsAt,
        resourceId,
        assignedStaffId: ctx.staffingConfigured ? eligibleStaffId : appointment.assignedStaffId,
        status: appointment.status,
        reminderSentAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.appointments.id, appointment.id));
    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "appointment.rescheduled",
      entityType: "appointment",
      entityId: appointment.id,
      before: {
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        resourceId: appointment.resourceId,
        assignedStaffId: appointment.assignedStaffId,
        status: appointment.status,
      },
      after: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        resourceId,
        assignedStaffId: ctx.staffingConfigured ? eligibleStaffId : appointment.assignedStaffId,
        status: appointment.status,
        reminderSentAt: null,
      },
    });
    return { appointmentId: appointment.id, startsAt, endsAt, resourceId, status: appointment.status };
  });
}
