"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import { formatInZone } from "@/lib/tz";
import {
  computeEstimateTotals,
  createEstimateAccessToken,
  nextEstimateNumber,
} from "@/lib/estimates";
import { createAppointmentInTransaction, BookingError } from "@/lib/booking/create";
import { getAvailableSlots } from "@/lib/booking/availability";
import { VEHICLE_CATEGORIES } from "@/lib/types";
import { getAppBaseUrl } from "@/lib/urls";

export type ActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

const lineSchema = z.object({
  serviceId: z.string().nullable().optional(),
  description: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(99),
  unitPriceCents: z.number().int().min(0).max(10_000_000),
  isOptional: z.boolean().default(false),
});

const createSchema = z.object({
  quoteRequestId: z.string().optional(),
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).default(""),
    email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
    phone: z.string().trim().max(30).optional().or(z.literal("").transform(() => undefined)),
  }),
  vehicle: z
    .object({
      year: z.number().int().min(1950).max(2030).optional(),
      make: z.string().trim().min(1).max(60),
      model: z.string().trim().min(1).max(60),
      category: z.enum(VEHICLE_CATEGORIES).default("other"),
    })
    .optional(),
  lines: z.array(lineSchema).min(1).max(30),
  discountCents: z.number().int().min(0).max(10_000_000).default(0),
  depositRequiredCents: z.number().int().min(0).max(10_000_000).default(0),
  customerMessage: z.string().trim().max(4000).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  validDays: z.number().int().min(1).max(365).default(30),
});

export async function createEstimateAction(
  raw: unknown,
): Promise<ActionResult<{ estimateId: string }>> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the estimate fields" };
    const input = parsed.data;
    if (!input.customer.email && !input.customer.phone) {
      return { ok: false, error: "Customer needs an email address or phone number" };
    }
    const settings = await getSettings();

    const estimateId = await db().transaction(async (tx) => {
      // Resolve the quote request (and its lead) when building from one.
      let quoteRequest = null;
      let lead = null;
      if (input.quoteRequestId) {
        const qr = await tx
          .select()
          .from(schema.quoteRequests)
          .where(eq(schema.quoteRequests.id, input.quoteRequestId))
          .for("update");
        quoteRequest = qr[0] ?? null;
        if (!quoteRequest) throw new Error("Quote request not found");
        if (quoteRequest.estimateId) throw new Error("This quote request already has an estimate");
        if (quoteRequest.leadId) {
          const l = await tx.select().from(schema.leads).where(eq(schema.leads.id, quoteRequest.leadId)).limit(1);
          lead = l[0] ?? null;
        }
      }

      // Customer: reuse the quote request's customer when present, else create.
      let customerId = quoteRequest?.customerId ?? null;
      if (!customerId) {
        customerId = newId("cus");
        await tx.insert(schema.customers).values({
          id: customerId,
          firstName: input.customer.firstName,
          lastName: input.customer.lastName,
          email: input.customer.email ?? null,
          phone: input.customer.phone ?? null,
          sourceLeadId: lead?.id ?? null,
          marketingConsent: lead?.marketingConsent ?? false,
          marketingConsentAt: lead?.marketingConsentAt ?? null,
          marketingConsentSource: lead?.marketingConsentSource ?? null,
        });
      }

      // A fleet/contact workflow may already have created the customer before
      // the quote becomes an estimate. Preserve an explicit lead opt-in when
      // linking that existing customer; never infer consent from contact data.
      if (customerId && lead?.marketingConsent) {
        await tx
          .update(schema.customers)
          .set({
            marketingConsent: true,
            marketingConsentAt: lead.marketingConsentAt ?? new Date(),
            marketingConsentSource: lead.marketingConsentSource ?? "lead_conversion",
            updatedAt: new Date(),
          })
          .where(eq(schema.customers.id, customerId));
      }

      let vehicleId = quoteRequest?.vehicleId ?? null;
      if (!vehicleId && input.vehicle) {
        vehicleId = newId("veh");
        await tx.insert(schema.vehicles).values({
          id: vehicleId,
          customerId,
          year: input.vehicle.year ?? null,
          make: input.vehicle.make,
          model: input.vehicle.model,
          category: input.vehicle.category,
        });
      }

      const number = await nextEstimateNumber(tx);
      const estimateId = newId("est");
      await tx.insert(schema.estimates).values({
        id: estimateId,
        number,
        customerId,
        vehicleId,
        quoteRequestId: quoteRequest?.id ?? null,
        status: "draft",
        discountCents: input.discountCents,
        taxRateBp: settings.taxRateBp,
        taxLabel: settings.taxLabel,
        depositRequiredCents: input.depositRequiredCents,
        customerMessage: input.customerMessage ?? null,
        internalNotes: input.internalNotes ?? null,
        expiresAt: new Date(Date.now() + input.validDays * 86_400_000),
        createdByStaffId: staff.id,
      });

      await tx.insert(schema.estimateLineItems).values(
        input.lines.map((line, i) => ({
          id: newId("eli"),
          estimateId,
          serviceId: line.serviceId ?? null,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          isOptional: line.isOptional,
          isSelected: true,
          sort: i,
        })),
      );

      if (quoteRequest) {
        await tx
          .update(schema.quoteRequests)
          .set({ status: "estimated", estimateId, customerId, vehicleId, updatedAt: new Date() })
          .where(eq(schema.quoteRequests.id, quoteRequest.id));
        if (lead) {
          await tx
            .update(schema.leads)
            .set({ status: "qualified", convertedCustomerId: customerId, updatedAt: new Date() })
            .where(eq(schema.leads.id, lead.id));
        }
      }

      const totals = computeEstimateTotals(
        input.lines.map((l) => ({ ...l, isSelected: true })),
        input.discountCents,
        settings.taxRateBp,
      );
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "estimate.created",
        entityType: "estimate",
        entityId: estimateId,
        after: { number, customerId, totalCents: totals.totalCents, lines: input.lines.length },
      });
      return estimateId;
    });

    revalidatePath("/admin/estimates");
    if (input.quoteRequestId) revalidatePath(`/admin/leads/quotes/${input.quoteRequestId}`);
    return { ok: true, estimateId };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createEstimateAction failed", err);
    return {
      ok: false,
      error:
        err instanceof Error &&
        ["Quote request not found", "This quote request already has an estimate"].includes(err.message)
          ? err.message
          : "Something went wrong",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export async function sendEstimateAction(
  raw: unknown,
): Promise<ActionResult<{ link: string; delivery: "email" | "sms" | null }>> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = z.object({ estimateId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { estimateId } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<
      | { ok: false; error: string }
      | { ok: true; token: string; estimate: typeof schema.estimates.$inferSelect; expiresAt: Date }
    > => {
      const rows = await tx.select().from(schema.estimates).where(eq(schema.estimates.id, estimateId)).for("update");
      const estimate = rows[0];
      if (!estimate) return { ok: false, error: "Estimate not found" };
      if (!["draft", "sent", "viewed", "changes_requested"].includes(estimate.status)) {
        return { ok: false, error: `A ${estimate.status} estimate cannot be sent` };
      }
      const expiresAt = estimate.expiresAt ?? new Date(Date.now() + 30 * 86_400_000);
      const token = await createEstimateAccessToken(tx, {
        estimateId,
        customerId: estimate.customerId,
        expiresAt,
      });
      await tx
        .update(schema.estimates)
        .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.estimates.id, estimateId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "estimate.sent",
        entityType: "estimate",
        entityId: estimateId,
        before: { status: estimate.status },
        after: { status: "sent" },
      });
      return { ok: true, token, estimate, expiresAt };
    });
    if (!result.ok) return { ok: false, error: result.error };

    const base = getAppBaseUrl();
    const link = `${base}/portal/estimates/${result.token}`;

    // Operational message (dev transport logs it).
    const customer = (
      await db().select().from(schema.customers).where(eq(schema.customers.id, result.estimate.customerId)).limit(1)
    )[0];
    const message = customer
      ? await sendMessageTemplate({
          templateKey: "estimate_sent",
          recipient: customer,
          customerId: customer.id,
          kind: "estimate",
          variables: {
            businessName: settings.businessName,
            firstName: customer.firstName,
            estimateNumber: String(result.estimate.number),
            link,
            expiry: formatInZone(result.expiresAt, settings.timezone, {
              month: "long",
              day: "numeric",
              year: "numeric",
            }),
          },
          relatedEntityType: "estimate",
          relatedEntityId: estimateId,
        })
      : null;

    revalidatePath(`/admin/estimates/${estimateId}`);
    revalidatePath("/admin/estimates");
    return { ok: true, link, delivery: message?.sent ? (message.channel ?? null) : null };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendEstimateAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Convert approved estimate → appointment                             */
/* ------------------------------------------------------------------ */

export async function getEstimateSlotsAction(
  raw: unknown,
): Promise<ActionResult<{ slots: { startMs: number; label: string }[] }>> {
  try {
    await requireStaff("manage_estimates");
    const parsed = z
      .object({
        estimateId: z.string().min(1),
        dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        durationMin: z.number().int().min(15).max(24 * 60),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const settings = await getSettings();
    const estimateLines = await db().select().from(schema.estimateLineItems)
      .where(eq(schema.estimateLineItems.estimateId, parsed.data.estimateId));
    const serviceIds = [...new Set(estimateLines
      .filter((line) => (!line.isOptional || line.isSelected) && line.serviceId)
      .map((line) => line.serviceId!))];
    const serviceRows = serviceIds.length > 0
      ? await db().select({ requiredSkills: schema.services.requiredSkills }).from(schema.services)
          .where(inArray(schema.services.id, serviceIds))
      : [];
    const requiredSkills = [...new Set(serviceRows.flatMap((service) => service.requiredSkills))];
    const slots = await getAvailableSlots({
      dateISO: parsed.data.dateISO,
      workDurationMin: parsed.data.durationMin,
      settings,
      requiredSkills,
    });
    return {
      ok: true,
      slots: slots.map((s) => ({
        startMs: s.start,
        label: formatInZone(new Date(s.start), settings.timezone, { hour: "numeric", minute: "2-digit" }),
      })),
    };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("getEstimateSlotsAction failed", err);
    return { ok: false, error: "Could not load availability" };
  }
}

export async function convertEstimateAction(
  raw: unknown,
): Promise<ActionResult<{ appointmentId: string }>> {
  try {
    const staff = await requireStaff("manage_estimates", "manage_bookings");
    const parsed = z
      .object({
        estimateId: z.string().min(1),
        dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startMs: z.number().int().positive(),
        durationMin: z.number().int().min(15).max(24 * 60),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const input = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ appointmentId: string }>> => {
      // The estimate lock is the idempotency boundary: only one concurrent
      // conversion can observe the approved state and reserve a bay.
      const [estimate] = await tx
        .select()
        .from(schema.estimates)
        .where(eq(schema.estimates.id, input.estimateId))
        .for("update");
      if (!estimate) return { ok: false, error: "Estimate not found" };
      if (estimate.status !== "approved") {
        return { ok: false, error: "Only approved estimates can be converted to an appointment" };
      }
      const [customer] = await tx
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, estimate.customerId))
        .limit(1);
      if (!customer) return { ok: false, error: "Customer record missing" };
      const vehicle = estimate.vehicleId
        ? (await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, estimate.vehicleId)).limit(1))[0]
        : undefined;
      if (!vehicle) {
        return { ok: false, error: "Add a vehicle to this estimate's customer before converting" };
      }
      const lines = await tx
        .select()
        .from(schema.estimateLineItems)
        .where(eq(schema.estimateLineItems.estimateId, input.estimateId));
      const selected = lines.filter((line) => !line.isOptional || line.isSelected);
      if (selected.length === 0) return { ok: false, error: "No selected line items to book" };
      const totals = computeEstimateTotals(selected, estimate.discountCents, estimate.taxRateBp);
      const selectedServiceIds = [...new Set(selected.flatMap((line) => line.serviceId ? [line.serviceId] : []))];
      const selectedServices = selectedServiceIds.length > 0
        ? await tx.select({ requiredSkills: schema.services.requiredSkills }).from(schema.services)
            .where(inArray(schema.services.id, selectedServiceIds))
        : [];
      const requiredSkills = [...new Set(selectedServices.flatMap((service) => service.requiredSkills))];

      const pricedLines = selected.map((line) => ({
        serviceId: line.serviceId ?? undefined,
        description: line.quantity > 1 ? `${line.description} × ${line.quantity}` : line.description,
        priceCents: line.quantity * line.unitPriceCents,
        durationMin: 0,
      }));
      if (totals.discountCents > 0) {
        pricedLines.push({
          serviceId: undefined,
          description: "Discount",
          priceCents: -totals.discountCents,
          durationMin: 0,
        });
      }
      pricedLines[0] = { ...pricedLines[0], durationMin: input.durationMin };

      const appointment = await createAppointmentInTransaction(
        tx,
        {
          customer: {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email ?? undefined,
            phone: customer.phone ?? undefined,
          },
          vehicle: {
            id: vehicle.id,
            make: vehicle.make,
            model: vehicle.model,
            category: vehicle.category as never,
          },
          pricing: {
            lines: pricedLines,
            subtotalCents: totals.subtotalCents - totals.discountCents,
            taxCents: totals.taxCents,
            taxRateBp: estimate.taxRateBp,
            totalCents: totals.totalCents,
            depositRequiredCents: estimate.depositRequiredCents,
            durationMin: input.durationMin,
            requiredSkills,
          },
          dateISO: input.dateISO,
          startMs: input.startMs,
          policiesAccepted: false,
          settings,
        },
        { type: "staff", id: staff.id },
      );

      await tx
        .update(schema.estimates)
        .set({
          status: "converted",
          convertedToType: "appointment",
          convertedToId: appointment.appointmentId,
          updatedAt: new Date(),
        })
        .where(eq(schema.estimates.id, input.estimateId));
      await tx
        .update(schema.appointments)
        .set({ estimateId: input.estimateId })
        .where(eq(schema.appointments.id, appointment.appointmentId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "estimate.converted",
        entityType: "estimate",
        entityId: input.estimateId,
        after: { appointmentId: appointment.appointmentId },
      });
      return { ok: true, appointmentId: appointment.appointmentId };
    });

    if (!result.ok) return result;

    revalidatePath(`/admin/estimates/${input.estimateId}`);
    revalidatePath("/admin/estimates");
    revalidatePath("/admin/appointments");
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    if (err instanceof BookingError) return { ok: false, error: err.message };
    console.error("convertEstimateAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
