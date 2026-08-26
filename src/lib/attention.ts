import { and, asc, eq, gt, gte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";

/**
 * The "needs attention" queue (spec §5) — soft rules, not blocking ones.
 *
 * Everything here describes a record that is *valid* but probably unfinished:
 * a car handed back that was never billed, or a deposit a downgrade left the
 * shop holding. The shop is meant to work through
 * them and watch the list empty, so each item carries a link to the record that
 * clears it. Nothing in here mutates anything, and nothing is ever
 * auto-corrected — inventing an invoice would be worse than the gap it fills.
 *
 * Spec §5 also listed "discount applied with no reason". That rule was built,
 * shipped, and withdrawn the same day: the owner does not record why a discount
 * was given, so every discounted invoice qualified and the card opened with ten
 * rows nobody could act on. A queue that cannot be emptied trains people to
 * ignore the queue. `invoices.discount_reason` is still stored and displayed
 * when staff choose to fill it in. See DECISIONS.md #18.
 */

export type AttentionItem = {
  kind: "uninvoiced_job" | "refundable_deposit";
  id: string;
  label: string;
  detail: string;
  href: string;
};

export type AttentionQueue = {
  items: AttentionItem[];
  uninvoicedJobs: number;
  refundableDeposits: number;
  total: number;
};

/**
 * Pure assembly of the queue from already-loaded rows, so the ordering and the
 * counts are unit-testable without a database.
 */
export function buildAttentionQueue(input: {
  uninvoicedJobs: readonly {
    id: string;
    vehicleLabel: string;
    readySinceLabel: string;
  }[];
  refundableDeposits?: readonly {
    id: string;
    vehicleLabel: string;
    refundableCents: number;
    currency?: string;
  }[];
}): AttentionQueue {
  const uninvoicedJobs: AttentionItem[] = input.uninvoicedJobs.map((job) => ({
    kind: "uninvoiced_job",
    id: job.id,
    label: `${job.vehicleLabel} was handed back but never invoiced`,
    detail: `Ready since ${job.readySinceLabel}`,
    href: `/admin/jobs/${job.id}`,
  }));
  // A downgrade at the counter can leave the deposit larger than the new
  // total. The invoice caps what it applies, so without this the difference
  // would simply vanish from every screen — real money, owed back, invisible.
  const refundableDeposits: AttentionItem[] = (input.refundableDeposits ?? []).map((appt) => ({
    kind: "refundable_deposit",
    id: appt.id,
    label: `${appt.vehicleLabel} is owed a deposit refund`,
    detail: `${formatCents(appt.refundableCents, appt.currency ?? "CAD")} of deposit is more than the revised total`,
    href: `/admin/appointments/${appt.id}`,
  }));
  const items = [...uninvoicedJobs, ...refundableDeposits];
  return {
    items,
    uninvoicedJobs: uninvoicedJobs.length,
    refundableDeposits: refundableDeposits.length,
    total: items.length,
  };
}

/**
 * Loader. `since` bounds the scan so the card stays about work in flight rather
 * than an archive — a car that has sat at ready-for-pickup for three months is
 * not going to be invoiced because a card mentioned it.
 */
export async function getAttentionQueue(input: {
  since: Date;
  formatDate: (date: Date) => string;
  currency?: string;
  limit?: number;
}): Promise<AttentionQueue> {
  const uninvoiced = await db()
    .select({
      id: schema.jobs.id,
      updatedAt: schema.jobs.updatedAt,
      year: schema.vehicles.year,
      make: schema.vehicles.make,
      model: schema.vehicles.model,
    })
    .from(schema.jobs)
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.jobs.vehicleId))
    .where(
      and(
        eq(schema.jobs.status, "ready_for_pickup"),
        isNull(schema.jobs.invoiceId),
        gte(schema.jobs.updatedAt, input.since),
      ),
    )
    .orderBy(asc(schema.jobs.updatedAt))
    .limit(input.limit ?? 10);

  // Revised bookings still holding more deposit than they are now worth.
  // Scoped to revised rows so this can only ever surface a counter downgrade,
  // never an ordinary appointment mid-flight.
  const overpaidDeposits = await db()
    .select({
      id: schema.appointments.id,
      depositPaidCents: schema.appointments.depositPaidCents,
      totalCents: schema.appointments.totalCents,
      year: schema.vehicles.year,
      make: schema.vehicles.make,
      model: schema.vehicles.model,
    })
    .from(schema.appointments)
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.appointments.vehicleId))
    .where(
      and(
        gt(schema.appointments.revisedAt, input.since),
        gt(schema.appointments.depositPaidCents, 0),
        // Column-to-column: the deposit held exceeds what the booking is now
        // worth, which is only possible after a downgrade.
        gt(schema.appointments.depositPaidCents, schema.appointments.totalCents),
      ),
    )
    .orderBy(asc(schema.appointments.revisedAt))
    .limit(input.limit ?? 10);

  return buildAttentionQueue({
    uninvoicedJobs: uninvoiced.map((row) => ({
      id: row.id,
      vehicleLabel: [row.year, row.make, row.model].filter(Boolean).join(" ") || "Vehicle",
      readySinceLabel: input.formatDate(row.updatedAt),
    })),
    refundableDeposits: overpaidDeposits.map((row) => ({
      id: row.id,
      vehicleLabel: [row.year, row.make, row.model].filter(Boolean).join(" ") || "Vehicle",
      refundableCents: row.depositPaidCents - row.totalCents,
      currency: input.currency,
    })),
  });
}
