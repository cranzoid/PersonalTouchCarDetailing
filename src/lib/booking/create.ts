import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { audit } from "@/lib/audit";
import type { BusinessSettings } from "@/lib/settings";
import type { Attribution } from "@/db/schema";
import type { BookingPricing } from "@/lib/pricing";
import type { VehicleCategory } from "@/lib/types";
import { computeDaySlots, loadDayContext, pickFreeBay, type Interval } from "./availability";

export class BookingError extends Error {}

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
  startMs: number;
  customerNotes?: string;
  attribution?: Attribution;
  policiesAccepted: boolean;
  settings: BusinessSettings;
};

/**
 * Creates an appointment with hard double-booking protection.
 *
 * Strategy: inside one transaction, take FOR UPDATE row locks on all active
 * bays. This serializes concurrent booking attempts; the availability window
 * is then re-validated from live data before insert. The advisory slot list
 * shown in the UI is never trusted.
 */
export async function createAppointment(req: BookingRequest): Promise<{
  appointmentId: string;
  customerId: string;
  vehicleId: string;
  status: string;
}> {
  if (!req.policiesAccepted) throw new BookingError("Policies must be accepted");
  if (!req.customer.email && !req.customer.phone) {
    throw new BookingError("An email address or phone number is required");
  }

  return db().transaction(async (tx) => {
    // Serialize concurrent bookings across the whole schedule.
    await tx.execute(sql`SELECT id FROM resources WHERE type = 'bay' AND active = true FOR UPDATE`);

    // Re-validate the slot from live data (post-lock). loadDayContext uses the
    // global db() handle, which is safe: the lock above guarantees no
    // concurrent booking transaction can commit between here and our insert.
    const { ctx, bayIds } = await loadDayContext({
      dateISO: req.dateISO,
      workDurationMin: req.pricing.durationMin,
      settings: req.settings,
    });
    const window: Interval = {
      start: req.startMs,
      end: req.startMs + ctx.totalDurationMin * 60_000,
    };
    const slots = computeDaySlots(ctx);
    if (!slots.some((s) => s.start === window.start)) {
      throw new BookingError("That time is no longer available. Please choose another slot.");
    }
    const bayIdx = pickFreeBay(ctx, window);
    if (bayIdx === null) {
      throw new BookingError("That time is no longer available. Please choose another slot.");
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
      resourceId: bayIds[bayIdx],
      subtotalCents: req.pricing.subtotalCents,
      taxCents: req.pricing.taxCents,
      taxRateBp: req.pricing.taxRateBp,
      totalCents: req.pricing.totalCents,
      depositRequiredCents: req.pricing.depositRequiredCents,
      durationMin: req.pricing.durationMin,
      customerNotes: req.customerNotes ?? null,
      attribution: req.attribution ?? null,
      policiesAcceptedAt: new Date(),
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
      actorType: "customer",
      action: "appointment.created",
      entityType: "appointment",
      entityId: appointmentId,
      after: { status, startsAt: new Date(window.start).toISOString(), totalCents: req.pricing.totalCents },
    });

    return { appointmentId, customerId, vehicleId, status };
  });
}
