import { eq, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { audit } from "@/lib/audit";
import type { BusinessSettings } from "@/lib/settings";
import type { Attribution } from "@/db/schema";
import { priceBooking, type BookingPricing } from "@/lib/pricing";
import { VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import { createAppointmentDepositAccessToken } from "@/lib/appointment-deposits";
import { computeDaySlots, loadDayContext, pickFreeBay, pickFreeStaff, type Interval } from "./availability";

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

type BookingActor = { type: "customer" } | { type: "staff"; id: string };

type BookingTx = Pick<Db, "execute" | "insert" | "update">;
type CreatedAppointment = {
  appointmentId: string;
  customerId: string;
  vehicleId: string;
  status: string;
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
    const { ctx, bayIds } = await loadDayContext({
      dateISO: req.dateISO,
      workDurationMin: req.pricing.durationMin,
      settings: req.settings,
      requiredSkills: req.pricing.requiredSkills,
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
    const assignedStaffId = pickFreeStaff(ctx, window);
    if (ctx.staffingConfigured && !assignedStaffId) {
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
      assignedStaffId: assignedStaffId ?? null,
      subtotalCents: req.pricing.subtotalCents,
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
        resourceId: bayIds[bayIdx],
        assignedStaffId: assignedStaffId ?? null,
        requiredSkills: req.pricing.requiredSkills,
        totalCents: req.pricing.totalCents,
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

    return { appointmentId, customerId, vehicleId, status, depositAccessToken };
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
  dateISO: string;
  startMs: number;
  customerNotes?: string;
  settings: BusinessSettings;
  staffId: string;
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

    const pricing = await priceBooking({
      serviceIds: input.serviceIds,
      addonIds: input.addonIds,
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
      },
      { type: "staff", id: input.staffId },
    );
  });
}
