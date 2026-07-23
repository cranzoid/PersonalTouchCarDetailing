import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { computeEstimateTotals } from "@/lib/estimates";
import { StatusBadge } from "@/components/admin";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function EstimatesPage() {
  await requirePageStaff("manage_estimates");
  const estimates = await db()
    .select({
      estimate: schema.estimates,
      customer: schema.customers,
    })
    .from(schema.estimates)
    .innerJoin(schema.customers, eq(schema.estimates.customerId, schema.customers.id))
    .orderBy(desc(schema.estimates.createdAt))
    .limit(100);

  const lineRows = estimates.length
    ? await db()
        .select()
        .from(schema.estimateLineItems)
        .where(inArray(schema.estimateLineItems.estimateId, estimates.map((e) => e.estimate.id)))
    : [];
  const linesByEstimate = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const list = linesByEstimate.get(line.estimateId) ?? [];
    list.push(line);
    linesByEstimate.set(line.estimateId, list);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Estimates</h1>
        <Link
          href="/admin/estimates/new"
          className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300"
        >
          New Estimate
        </Link>
      </div>
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-800 text-xs uppercase tracking-wider text-ink-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {estimates.map(({ estimate, customer }) => {
              const totals = computeEstimateTotals(
                linesByEstimate.get(estimate.id) ?? [],
                estimate.discountCents,
                estimate.taxRateBp,
              );
              return (
                <tr key={estimate.id} className="border-b border-ink-800/60 hover:bg-ink-900/40">
                  <td className="px-4 py-3">
                    <Link href={`/admin/estimates/${estimate.id}`} className="font-medium text-accent-300">
                      EST-{estimate.number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-200">
                    {customer.firstName} {customer.lastName}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={estimate.status} /></td>
                  <td className="px-4 py-3 text-ink-200">{formatCents(totals.totalCents)}</td>
                  <td className="px-4 py-3 text-ink-400">
                    {estimate.createdAt.toLocaleDateString("en-CA")}
                  </td>
                </tr>
              );
            })}
            {estimates.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-500">
                  No estimates yet. Create one from a quote request or start blank.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
