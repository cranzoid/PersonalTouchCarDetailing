import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * The "needs attention" queue (spec §5) — soft rules, not blocking ones.
 *
 * Everything here describes a record that is *valid* but probably unfinished:
 * a car handed back that was never billed. The shop is meant to work through
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
  kind: "uninvoiced_job";
  id: string;
  label: string;
  detail: string;
  href: string;
};

export type AttentionQueue = {
  items: AttentionItem[];
  uninvoicedJobs: number;
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
}): AttentionQueue {
  const items: AttentionItem[] = input.uninvoicedJobs.map((job) => ({
    kind: "uninvoiced_job",
    id: job.id,
    label: `${job.vehicleLabel} was handed back but never invoiced`,
    detail: `Ready since ${job.readySinceLabel}`,
    href: `/admin/jobs/${job.id}`,
  }));
  return { items, uninvoicedJobs: items.length, total: items.length };
}

/**
 * Loader. `since` bounds the scan so the card stays about work in flight rather
 * than an archive — a car that has sat at ready-for-pickup for three months is
 * not going to be invoiced because a card mentioned it.
 */
export async function getAttentionQueue(input: {
  since: Date;
  formatDate: (date: Date) => string;
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

  return buildAttentionQueue({
    uninvoicedJobs: uninvoiced.map((row) => ({
      id: row.id,
      vehicleLabel: [row.year, row.make, row.model].filter(Boolean).join(" ") || "Vehicle",
      readySinceLabel: input.formatDate(row.updatedAt),
    })),
  });
}
