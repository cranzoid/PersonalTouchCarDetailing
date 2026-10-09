import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { taxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import type { MembershipBenefit } from "./config";
import { memberAllocation, resolveMemberPricing } from "./pricing";
import { MembershipError, reserveMembershipBenefit, reservePassWash } from "./service";

const OPEN_STATUSES = new Set(["pending", "deposit_required", "confirmed", "arrived", "converted", "completed"]);

/**
 * Applies a car's membership (or Winter Pass) to a booking at the counter —
 * the car is in front of staff, so the plate on it is what decides. Spends the
 * chosen benefits against this appointment and re-prices it: the member
 * allocation replaces the booking's discount only when it is worth more,
 * matching "the best single offer wins" everywhere else.
 *
 * Refused once the visit has an invoice: the invoice is the tax document, and
 * it is re-priced through the ordinary counter revision, not behind it.
 */
export async function applyMemberBenefitsToAppointment(input: {
  appointmentId: string;
  staffId: string;
  spendBenefits: MembershipBenefit[];
  spendPassWash: boolean;
}): Promise<{ ok: true; discountCents: number } | { ok: false; error: string }> {
  const [appointment] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, input.appointmentId)).limit(1);
  if (!appointment) return { ok: false, error: "Appointment not found" };
  const member = await resolveMemberPricing({
    vehicleId: appointment.vehicleId,
    spendBenefits: input.spendBenefits,
    spendPassWash: input.spendPassWash,
    at: appointment.startsAt,
  });
  if (!member) return { ok: false, error: "This car has no membership benefit or pass wash to apply." };
  const settings = await getSettings();

  try {
    return await db().transaction(async (tx) => {
      const [locked] = await tx.select().from(schema.appointments).where(eq(schema.appointments.id, input.appointmentId)).for("update");
      if (!locked || !OPEN_STATUSES.has(locked.status)) return { ok: false as const, error: "This appointment can no longer be changed." };
      if (locked.jobId) {
        const [job] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, locked.jobId));
        if (job?.invoiceId) return { ok: false as const, error: "This visit is already invoiced. Apply member benefits before raising the invoice." };
      }
      const lines = await tx
        .select()
        .from(schema.appointmentServices)
        .where(eq(schema.appointmentServices.appointmentId, locked.id))
        .orderBy(asc(schema.appointmentServices.sort));
      const priced = lines.map((line) => ({
        serviceId: line.serviceId ?? undefined,
        addonId: line.addonId ?? undefined,
        description: line.description,
        priceCents: line.priceCents,
        durationMin: line.durationMin,
      }));
      const { allocation, entitlements } = memberAllocation(priced, member);
      const memberDiscount = allocation.reduce((sum, cents) => sum + cents, 0);
      if (memberDiscount <= 0) {
        return { ok: false as const, error: "Nothing on this booking is covered — add the member's wash or a detailing package first." };
      }
      if (memberDiscount <= locked.discountCents) {
        return { ok: false as const, error: "The booking already has a bigger discount than the membership would give." };
      }
      for (const entitlement of entitlements) {
        if (entitlement.type === "membership_benefit") {
          await reserveMembershipBenefit(tx, {
            membershipId: entitlement.membershipId,
            benefit: entitlement.benefit,
            appointmentId: locked.id,
            staffId: input.staffId,
          });
        } else {
          await reservePassWash(tx, { passId: entitlement.passId, appointmentId: locked.id, staffId: input.staffId, at: locked.startsAt });
        }
      }
      const discountCents = Math.min(memberDiscount, locked.subtotalCents);
      const tax = taxCents(locked.subtotalCents - discountCents, locked.taxRateBp > 0 ? locked.taxRateBp : settings.taxRateBp);
      const totalCents = locked.subtotalCents - discountCents + tax;
      await tx
        .update(schema.appointments)
        .set({
          discountCents,
          promoLabel: member.label,
          promoCode: null,
          taxCents: tax,
          totalCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.appointments.id, locked.id));
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: "appointment.member_benefits_applied",
        entityType: "appointment",
        entityId: locked.id,
        before: { discountCents: locked.discountCents, promoLabel: locked.promoLabel, totalCents: locked.totalCents },
        after: { discountCents, promoLabel: member.label, totalCents, entitlements },
      });
      return { ok: true as const, discountCents };
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    throw error;
  }
}
