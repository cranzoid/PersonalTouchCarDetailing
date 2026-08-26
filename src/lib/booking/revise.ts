import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { computeInvoiceTotals } from "@/lib/invoices";
import { computeTotals, type PricedLine } from "@/lib/pricing";
import type { BusinessSettings } from "@/lib/settings";
import { APPOINTMENT_BLOCKING_STATUSES } from "@/lib/types";
import { isJobOpenForRepricing } from "@/lib/job-status";
import { BookingError } from "./create";

/**
 * Re-pricing a booking the customer changed at the counter.
 *
 * The shop's reality is that people move up or down a package once they are
 * standing in the bay. Until this existed the booked lines were frozen from the
 * moment of booking — `appointment_services` was written by `createAppointment`
 * and by nothing else — so an upgrade had to be billed as a bolt-on
 * "additional work" line and a downgrade had no path at all short of
 * abandoning the invoice and hand-typing a new one, which silently dropped the
 * job link, the deposit and the promo provenance.
 *
 * This rewrites the booking rather than layering an adjustment on top of it,
 * because the invoice should read "Package 3", not "Package 2 + upgrade". What
 * the customer originally booked survives in the audit log and in
 * `appointments.original_subtotal_cents`.
 */

export type ReviseDiscountMode = "reapply" | "keep" | "remove";

export type ReviseOutcome =
  | {
      ok: false;
      /** The bay is double-booked by the new, longer duration. Re-submit with `confirmOverlap`. */
      kind: "overlap";
      warnings: string[];
    }
  | {
      ok: true;
      appointmentId: string;
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      totalCents: number;
      durationMin: number;
      endsAt: Date;
      /** Deposit taken that the new, smaller total cannot absorb. Owed back. */
      depositRefundableCents: number;
      /** Set when a draft invoice was rewritten in place. */
      rebuiltInvoiceId: string | null;
      warnings: string[];
    };

/**
 * Which appointment statuses may be re-priced.
 *
 * `arrived` is the ordinary case — the customer is at the counter. `confirmed`
 * and `pending` cover a change phoned in beforehand. A `deposit_required`
 * booking is deliberately included: the deposit is a no-show hold and the
 * revision does not re-base it, so there is nothing inconsistent about
 * changing the package while one is outstanding.
 */
const REVISABLE = new Set(["pending", "deposit_required", "confirmed", "arrived"]);

/**
 * Applies the staff's choice about a promotional discount to the new cart.
 *
 * Pure, so the money rule is unit-testable without a database.
 *
 * A deliberate, narrow exception to DECISIONS.md #14 ("locked in cents, never
 * recalculated"). That rule exists to stop an *incidental* code path from
 * recomputing a stored rate behind everyone's back. Here a staff member is
 * knowingly re-pricing a sale that changed, and the mode they picked is
 * recorded on the invoice and in the audit log.
 */
export function reviseDiscountCents(input: {
  mode: ReviseDiscountMode;
  /** What the offer is worth against the NEW cart; 0 when it does not apply. */
  reappliedCents: number;
  /** What was locked at booking. */
  originalCents: number;
  newSubtotalCents: number;
}): number {
  const raw =
    input.mode === "reapply"
      ? input.reappliedCents
      : input.mode === "keep"
        ? input.originalCents
        : 0;
  // Clamped to the new subtotal exactly as computeTotals and
  // computeInvoiceTotals clamp, so the appointment and the invoice it becomes
  // can never disagree by a cent.
  return Math.min(Math.max(0, raw), input.newSubtotalCents);
}

/** The human-readable "why" that rides onto `invoices.discount_reason`. */
export function revisionDiscountReason(
  mode: ReviseDiscountMode,
  promoLabel: string | null,
  staffReason: string,
): string | null {
  if (mode === "remove") return null;
  const offer = promoLabel ?? "Discount locked at booking";
  return mode === "reapply"
    ? `${offer} — re-applied to revised package (${staffReason})`
    : `${offer} — original amount kept on revised package (${staffReason})`;
}

export async function reviseAppointmentLines(input: {
  appointmentId: string;
  /** Server-priced lines for the new cart. Never client-supplied amounts. */
  lines: PricedLine[];
  /** What the booking's promotion is worth against `lines`, computed server-side. */
  reappliedDiscountCents: number;
  discountMode: ReviseDiscountMode;
  reason: string;
  staffId: string;
  settings: BusinessSettings;
  /** Second-press acknowledgement that the longer job overruns the next booking. */
  confirmOverlap?: boolean;
}): Promise<ReviseOutcome> {
  if (input.lines.length === 0) {
    throw new BookingError("A revision needs at least one service or custom line");
  }

  return db().transaction(async (tx): Promise<ReviseOutcome> => {
    // The same lock order booking creation and rescheduling take. Held before
    // the overlap read below so a concurrent booking cannot slip into the bay
    // between the check and the write.
    await tx.execute(sql`SELECT id FROM resources WHERE type = 'bay' AND active = true ORDER BY id FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM staff_users WHERE active = true ORDER BY id FOR UPDATE`);

    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    if (!appointment) throw new BookingError("Appointment not found");
    if (!REVISABLE.has(appointment.status)) {
      throw new BookingError(
        `A ${appointment.status.replaceAll("_", " ")} appointment cannot be re-priced`,
      );
    }

    // A job that has been handed back is finished work; re-pricing it is a
    // credit note, not a revision. Note this is isJobOpenForRepricing, NOT
    // isJobOpenForSideWork: the latter stops at `in_progress`, and an invoice
    // only exists from `ready_for_pickup`, so using it would make the draft
    // rebuild below unreachable.
    const [job] = await tx
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.appointmentId, appointment.id))
      .limit(1);
    if (job && !isJobOpenForRepricing(job.status)) {
      throw new BookingError("This job is too far along to change the packages");
    }

    // A draft invoice is rewritten below. Anything further along has been shown
    // to the customer, and rewriting a sent document quietly is not something
    // to do behind their back.
    const invoiceId = job?.invoiceId ?? null;
    const [invoice] = invoiceId
      ? await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update")
      : [];
    if (invoice && invoice.status !== "draft") {
      throw new BookingError(
        `Invoice #${invoice.number} has already been ${invoice.status.replaceAll("_", " ")} — cancel it before changing the packages`,
      );
    }

    const subtotalCents = input.lines.reduce((sum, line) => sum + line.priceCents, 0);
    const discountCents = reviseDiscountCents({
      mode: input.discountMode,
      reappliedCents: input.reappliedDiscountCents,
      originalCents: appointment.discountCents,
      newSubtotalCents: subtotalCents,
    });
    // `appointment.taxRateBp`, NEVER settings.taxRateBp: a zero-rated booking
    // must stay zero-rated through a revision. Same trap as the `??`-not-`||`
    // fix in createInvoiceFromJobAction.
    const totals = computeTotals(input.lines, appointment.taxRateBp, 0, {
      cents: discountCents,
      code: appointment.promoCode,
      label: appointment.promoLabel,
    });

    // Buffers bracket the work exactly as loadDayContext computes them, so a
    // revised appointment occupies the bay on the same terms as a booked one.
    const startMs = appointment.startsAt.getTime();
    const totalDurationMin =
      input.settings.setupBufferMin + totals.durationMin + input.settings.cleanupBufferMin;
    const endsAt = new Date(startMs + totalDurationMin * 60_000);

    const warnings: string[] = [];
    // Only a LENGTHENING run can newly collide. A downgrade shortens the job
    // and is always safe, so it is applied without ceremony.
    if (endsAt.getTime() > appointment.endsAt.getTime() && appointment.resourceId) {
      const clashes = await tx
        .select({ id: schema.appointments.id, startsAt: schema.appointments.startsAt })
        .from(schema.appointments)
        .where(
          and(
            eq(schema.appointments.resourceId, appointment.resourceId),
            ne(schema.appointments.id, appointment.id),
            inArray(schema.appointments.status, APPOINTMENT_BLOCKING_STATUSES),
            lt(schema.appointments.startsAt, endsAt),
            gt(schema.appointments.endsAt, appointment.startsAt),
          ),
        );
      if (clashes.length > 0) {
        const warning =
          clashes.length === 1
            ? "The longer job runs into the next booking in this bay."
            : `The longer job runs into ${clashes.length} later bookings in this bay.`;
        // Warn, do not block. Whether to take the money and run late is the
        // shop's call; the software's job is to make sure nobody finds out at
        // three o'clock.
        if (!input.confirmOverlap) return { ok: false, kind: "overlap", warnings: [warning] };
        warnings.push(warning);
      }
    }

    await tx
      .delete(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointment.id));
    await tx.insert(schema.appointmentServices).values(
      input.lines.map((line, i) => ({
        id: newId("aps"),
        appointmentId: appointment.id,
        serviceId: line.serviceId ?? null,
        addonId: line.addonId ?? null,
        description: line.description,
        priceCents: line.priceCents,
        durationMin: line.durationMin,
        sort: i,
      })),
    );

    await tx
      .update(schema.appointments)
      .set({
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        durationMin: totals.durationMin,
        endsAt,
        // `??` so a second revision keeps the FIRST subtotal — the figure the
        // ad actually sold — rather than the previous revision's.
        originalSubtotalCents: appointment.originalSubtotalCents ?? appointment.subtotalCents,
        revisedAt: new Date(),
        // promoCode/promoLabel are deliberately untouched: the ad that produced
        // this booking did not change because the package did.
        updatedAt: new Date(),
      })
      .where(eq(schema.appointments.id, appointment.id));

    // A deposit is never re-based downward into a refund automatically — see
    // refundAppointmentDepositAction. This is what the shop owes back, derived
    // rather than stored so it cannot drift out of step with the two figures
    // it sits between.
    const depositRefundableCents = Math.max(
      0,
      appointment.depositPaidCents - Math.min(appointment.depositPaidCents, totals.totalCents),
    );
    if (depositRefundableCents > 0) {
      warnings.push("The deposit already taken is larger than the new total — a refund is owed.");
    }

    let rebuiltInvoiceId: string | null = null;
    if (invoice) {
      // Rewritten in place, keeping its number and its invoice_jobs row. A
      // draft has no payments against it by definition, which is the same
      // guarantee cancelInvoiceAction relies on.
      const invoiceLines = input.lines.map((line) => ({
        serviceId: line.serviceId ?? null,
        description: line.description,
        quantity: 1,
        unitPriceCents: line.priceCents,
      }));
      // A staff exemption already on the draft outranks the appointment's rate
      // and survives the rebuild; the payment-method rule still settles at
      // payment time either way.
      const invoiceTaxRateBp = invoice.taxExempt ? 0 : appointment.taxRateBp;
      const invoiceTotals = computeInvoiceTotals(invoiceLines, totals.discountCents, invoiceTaxRateBp);
      await tx
        .delete(schema.invoiceLineItems)
        .where(eq(schema.invoiceLineItems.invoiceId, invoice.id));
      await tx.insert(schema.invoiceLineItems).values(
        invoiceLines.map((line, i) => ({
          id: newId("ili"),
          invoiceId: invoice.id,
          serviceId: line.serviceId,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          sort: i,
        })),
      );
      await tx
        .update(schema.invoices)
        .set({
          subtotalCents: invoiceTotals.subtotalCents,
          discountCents: invoiceTotals.discountCents,
          taxRateBp: invoiceTaxRateBp,
          taxCents: invoiceTotals.taxCents,
          totalCents: invoiceTotals.totalCents,
          depositAppliedCents: Math.min(appointment.depositPaidCents, invoiceTotals.totalCents),
          discountReason:
            invoiceTotals.discountCents > 0
              ? revisionDiscountReason(input.discountMode, appointment.promoLabel, input.reason)
              : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, invoice.id));
      rebuiltInvoiceId = invoice.id;
    }

    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "appointment.lines_revised",
      entityType: "appointment",
      entityId: appointment.id,
      before: {
        subtotalCents: appointment.subtotalCents,
        discountCents: appointment.discountCents,
        totalCents: appointment.totalCents,
        durationMin: appointment.durationMin,
        endsAt: appointment.endsAt.toISOString(),
      },
      after: {
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        totalCents: totals.totalCents,
        durationMin: totals.durationMin,
        endsAt: endsAt.toISOString(),
        discountMode: input.discountMode,
        promoCode: appointment.promoCode,
        lines: input.lines.map((line) => ({
          description: line.description,
          priceCents: line.priceCents,
        })),
        rebuiltInvoiceId,
        depositRefundableCents,
        overlapConfirmed: warnings.length > 0 && input.confirmOverlap === true,
      },
      reason: input.reason,
    });

    return {
      ok: true,
      appointmentId: appointment.id,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      durationMin: totals.durationMin,
      endsAt,
      depositRefundableCents,
      rebuiltInvoiceId,
      warnings,
    };
  });
}
