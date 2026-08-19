import { and, asc, eq, gt, gte, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * The "needs attention" queue (spec §5) — soft rules, not blocking ones.
 *
 * Everything here describes a record that is *valid* but probably unfinished:
 * a discount nobody explained, a car handed back that was never billed. The
 * shop is meant to work through them and watch the list empty, so each item
 * carries a link to the record that clears it. Nothing in here mutates
 * anything, and nothing is ever auto-corrected — inventing a discount reason
 * or an invoice would be worse than the gap it fills.
 */

export type AttentionItem = {
  kind: "discount_without_reason" | "uninvoiced_job";
  id: string;
  label: string;
  detail: string;
  href: string;
};

export type AttentionQueue = {
  items: AttentionItem[];
  discountWithoutReason: number;
  uninvoicedJobs: number;
  total: number;
};

/** Statuses where an invoice is a real document rather than a work in progress. */
const ISSUED = ["sent", "partially_paid", "paid", "overdue"] as const;

/**
 * Pure assembly of the queue from already-loaded rows, so the ordering and the
 * counts are unit-testable without a database.
 */
export function buildAttentionQueue(input: {
  discountedInvoices: readonly {
    id: string;
    number: number;
    discountCents: number;
    customerName: string;
  }[];
  uninvoicedJobs: readonly {
    id: string;
    vehicleLabel: string;
    readySinceLabel: string;
  }[];
  formatMoney: (cents: number) => string;
}): AttentionQueue {
  const items: AttentionItem[] = [
    // Money left on the table outranks paperwork: an uninvoiced car is revenue
    // the shop has not asked for yet.
    ...input.uninvoicedJobs.map(
      (job): AttentionItem => ({
        kind: "uninvoiced_job",
        id: job.id,
        label: `${job.vehicleLabel} was handed back but never invoiced`,
        detail: `Ready since ${job.readySinceLabel}`,
        href: `/admin/jobs/${job.id}`,
      }),
    ),
    ...input.discountedInvoices.map(
      (invoice): AttentionItem => ({
        kind: "discount_without_reason",
        id: invoice.id,
        label: `INV-${invoice.number} gave ${input.formatMoney(invoice.discountCents)} off with no reason recorded`,
        detail: invoice.customerName,
        href: `/admin/invoices/${invoice.id}`,
      }),
    ),
  ];
  return {
    items,
    discountWithoutReason: input.discountedInvoices.length,
    uninvoicedJobs: input.uninvoicedJobs.length,
    total: items.length,
  };
}

/**
 * Loader. `since` bounds the scan so the card stays cheap and does not resurrect
 * paperwork from before Release 3 — every invoice raised before the swap has a
 * NULL `discount_reason` simply because the column did not exist, and dumping
 * years of those on the owner's home screen would train them to ignore it.
 */
export async function getAttentionQueue(input: {
  since: Date;
  formatMoney: (cents: number) => string;
  formatDate: (date: Date) => string;
  limit?: number;
}): Promise<AttentionQueue> {
  const limit = input.limit ?? 10;

  const discounted = await db()
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      discountCents: schema.invoices.discountCents,
      firstName: schema.customers.firstName,
      lastName: schema.customers.lastName,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(
      and(
        gte(schema.invoices.createdAt, input.since),
        gt(schema.invoices.discountCents, 0),
        or(isNull(schema.invoices.discountReason), eq(schema.invoices.discountReason, "")),
        inArray(schema.invoices.status, [...ISSUED]),
      ),
    )
    .orderBy(asc(schema.invoices.createdAt))
    .limit(limit);

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
    .limit(limit);

  return buildAttentionQueue({
    discountedInvoices: discounted.map((row) => ({
      id: row.id,
      number: row.number,
      discountCents: row.discountCents,
      customerName: `${row.firstName} ${row.lastName}`.trim(),
    })),
    uninvoicedJobs: uninvoiced.map((row) => ({
      id: row.id,
      vehicleLabel: [row.year, row.make, row.model].filter(Boolean).join(" ") || "Vehicle",
      readySinceLabel: input.formatDate(row.updatedAt),
    })),
    formatMoney: input.formatMoney,
  });
}
