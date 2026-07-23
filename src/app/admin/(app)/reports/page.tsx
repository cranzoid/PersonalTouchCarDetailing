import Link from "next/link";
import { requirePageStaff } from "@/lib/auth/page";
import { formatCents } from "@/lib/money";
import {
  getReportingSnapshot,
  parseReportDays,
  REPORT_DAY_OPTIONS,
  type FunnelStage,
} from "@/lib/reporting";
import { formatInZone } from "@/lib/tz";

export const dynamic = "force-dynamic";

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
}

function sourceLabel(source: string): string {
  if (source === "unattributed") return "Unattributed";
  return source
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900/50 p-5">
      <p className="text-sm text-ink-400">{label}</p>
      <p className="mt-1 text-3xl font-bold text-white">{value}</p>
      <p className="mt-2 text-xs text-ink-400">{note}</p>
    </div>
  );
}

function FunnelRow({ stage }: { stage: FunnelStage }) {
  return (
    <tr className="border-t border-ink-800">
      <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
        {stage.label}
      </th>
      <td className="px-4 py-3 text-right text-white">{stage.count}</td>
      <td className="px-4 py-3 text-right text-ink-300">{formatPercent(stage.stepRate)}</td>
      <td className="px-4 py-3 text-right text-ink-300">{formatPercent(stage.overallRate)}</td>
    </tr>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requirePageStaff("view_financial_reports");
  const { range } = await searchParams;
  const days = parseReportDays(range);
  const report = await getReportingSnapshot(days);
  const lastMoment = new Date(report.window.end.getTime() - 1);
  const periodLabel = `${formatInZone(report.window.start, report.timezone, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })} – ${formatInZone(lastMoment, report.timezone, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Reports</h1>
          <p className="mt-1 text-sm text-ink-400">
            Cash revenue, lead conversion, capacity utilization and source attribution.
          </p>
          <p className="mt-1 text-xs text-ink-400">
            {periodLabel} · {report.timezone}
          </p>
        </div>
        <nav aria-label="Reporting period" className="flex flex-wrap gap-2">
          {REPORT_DAY_OPTIONS.map((option) => (
            <Link
              key={option}
              href={`/admin/reports?range=${option}`}
              aria-current={days === option ? "page" : undefined}
              className={`rounded-full px-4 py-1.5 text-sm ${
                days === option
                  ? "bg-accent-400 font-semibold text-ink-950"
                  : "bg-ink-800 text-ink-300 hover:text-white"
              }`}
            >
              {option} days
            </Link>
          ))}
        </nav>
      </div>

      <section aria-labelledby="revenue-heading" className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="revenue-heading" className="text-lg font-semibold text-white">
            Revenue
          </h2>
          <p className="text-xs text-ink-400">
            Cash basis: succeeded deposits and payments less succeeded refunds.
          </p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Net revenue"
            value={formatCents(report.revenue.netCents, report.currency)}
            note="Gross cash received less refunds"
          />
          <Kpi
            label="Gross received"
            value={formatCents(report.revenue.grossCents, report.currency)}
            note={`${report.revenue.paymentCount} successful payment event${report.revenue.paymentCount === 1 ? "" : "s"}`}
          />
          <Kpi
            label="Refunded"
            value={formatCents(report.revenue.refundCents, report.currency)}
            note={`${report.revenue.refundCount} successful refund${report.revenue.refundCount === 1 ? "" : "s"}`}
          />
          <Kpi
            label="Lead → booking"
            value={formatPercent(report.funnel.leadToBookingRate)}
            note="Unique leads captured in this period"
          />
        </div>
      </section>

      <div className="mt-10 grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="funnel-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="funnel-heading" className="text-lg font-semibold text-white">
              Lead cohort funnel
            </h2>
            <p className="text-xs text-ink-400">Unique leads; repeat bookings count once.</p>
          </div>
          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <caption className="sr-only">Lead cohort conversion stages</caption>
              <thead className="bg-ink-900 text-ink-400">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left">Stage</th>
                  <th scope="col" className="px-4 py-3 text-right">Leads</th>
                  <th scope="col" className="px-4 py-3 text-right">From prior</th>
                  <th scope="col" className="px-4 py-3 text-right">From captured</th>
                </tr>
              </thead>
              <tbody>
                {report.funnel.stages.map((stage) => (
                  <FunnelRow key={stage.key} stage={stage} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-ink-800 p-4">
              <p className="text-xs text-ink-400">Requested quotes</p>
              <p className="mt-1 text-xl font-semibold text-white">{report.funnel.quoteLeadCount}</p>
            </div>
            <div className="rounded-xl border border-ink-800 p-4">
              <p className="text-xs text-ink-400">Received estimates</p>
              <p className="mt-1 text-xl font-semibold text-white">{report.funnel.estimatedLeadCount}</p>
            </div>
            <div className="rounded-xl border border-ink-800 p-4">
              <p className="text-xs text-ink-400">Lead → completed</p>
              <p className="mt-1 text-xl font-semibold text-white">
                {formatPercent(report.funnel.leadToCompletionRate)}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-400">
            This is a cohort report: it follows leads created in the selected period through their
            current customer, booking and completed-job outcomes.
          </p>
        </section>

        <section aria-labelledby="sources-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="sources-heading" className="text-lg font-semibold text-white">
              Source → net revenue
            </h2>
            <p className="text-xs text-ink-400">Appointment source, then originating-lead fallback.</p>
          </div>
          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <caption className="sr-only">Revenue grouped by marketing source</caption>
              <thead className="bg-ink-900 text-ink-400">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left">Source</th>
                  <th scope="col" className="px-4 py-3 text-right">Gross</th>
                  <th scope="col" className="px-4 py-3 text-right">Refunds</th>
                  <th scope="col" className="px-4 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {report.sourceRevenue.map((source) => (
                  <tr key={source.source} className="border-t border-ink-800">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                      {sourceLabel(source.source)}
                    </th>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(source.grossCents, report.currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(source.refundCents, report.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-white">
                      {formatCents(source.netCents, report.currency)}
                    </td>
                  </tr>
                ))}
                {report.sourceRevenue.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-ink-400">
                      No successful payment activity in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section aria-labelledby="utilization-heading" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="utilization-heading" className="text-lg font-semibold text-white">
            Resource utilization
          </h2>
          <p className="text-xs text-ink-400">
            Scheduled time ÷ business-hours capacity after resource and full-business closures.
          </p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Kpi
            label="Overall utilization"
            value={formatPercent(report.utilization.utilizationRate)}
            note={`${formatHours(report.utilization.bookedMinutes)} booked of ${formatHours(report.utilization.availableMinutes)} available`}
          />
          <Kpi
            label="Booked resource time"
            value={formatHours(report.utilization.bookedMinutes)}
            note="Cancelled, no-show and rescheduled bookings excluded"
          />
          <Kpi
            label="Unassigned time"
            value={formatHours(report.utilization.unassignedBookedMinutes)}
            note="Active booking time without a resource assignment"
          />
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <caption className="sr-only">Utilization by active resource</caption>
            <thead className="bg-ink-900 text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3 text-left">Resource</th>
                <th scope="col" className="px-4 py-3 text-left">Type</th>
                <th scope="col" className="px-4 py-3 text-right">Booked</th>
                <th scope="col" className="px-4 py-3 text-right">Available</th>
                <th scope="col" className="px-4 py-3 text-right">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {report.utilization.resources.map((resource) => (
                <tr key={resource.resourceId} className="border-t border-ink-800">
                  <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                    {resource.name}
                  </th>
                  <td className="px-4 py-3 capitalize text-ink-400">{resource.type}</td>
                  <td className="px-4 py-3 text-right text-ink-300">
                    {formatHours(resource.bookedMinutes)}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-300">
                    {formatHours(resource.availableMinutes)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-white">
                    {formatPercent(resource.utilizationRate)}
                  </td>
                </tr>
              ))}
              {report.utilization.resources.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-ink-400">
                    No active resources are configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
