"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import type { AppointmentStatus } from "@/lib/types";

/** Legal appointment status transitions (staff-driven). */
const TRANSITIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  deposit_required: ["confirmed", "cancelled"],
  confirmed: ["arrived", "cancelled", "no_show"],
  arrived: ["completed", "converted"],
};

const input = z.object({
  appointmentId: z.string().min(1),
  to: z.enum(["confirmed", "arrived", "cancelled", "no_show", "completed"]),
  reason: z.string().trim().max(1000).optional(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

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
