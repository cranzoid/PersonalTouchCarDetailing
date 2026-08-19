import Link from "next/link";
import {
  FinanceMetric,
  FinanceWorkspaceHeader,
  financeButton,
} from "@/components/finance-workspace";
import { PeriodNav } from "@/components/period-nav";
import { requirePageStaff } from "@/lib/auth/page";
import { getBooksSnapshot, getPeriodWindow, type PeriodKind } from "@/lib/books";
import { getPayrollSnapshot } from "@/lib/payroll";
import { getSettings } from "@/lib/settings";
import { formatCents } from "@/lib/money";
import { PAYMENT_PROVIDER_LABELS } from "@/lib/payment-labels";
import {
  getReportingSnapshot,
  parseReportDays,
  REPORT_DAY_OPTIONS,
  type FunnelStage,
} from "@/lib/reporting";
import { formatInZone, localDateISO } from "@/lib/tz";

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
  return <FinanceMetric label={label} value={value} detail={note} />;
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
  searchParams: Promise<{ range?: string; kind?: string; y?: string; i?: string }>;
}) {
  await requirePageStaff("view_financial_reports");
  const params = await searchParams;
  const days = parseReportDays(params.range);
  const settings = await getSettings();
  const [thisYear, thisMonth] = localDateISO(settings.timezone).split("-").map(Number);

  // The P&L runs on whole calendar periods — a month, quarter or year is what a
  // tax return and a bank statement are built from — while the sections below
  // keep the rolling 7/30/90-day windows they have always used.
  const kinds: PeriodKind[] = ["month", "quarter", "year"];
  const kind = kinds.includes(params.kind as PeriodKind) ? (params.kind as PeriodKind) : "month";
  const year = Number(params.y) || thisYear;
  const index =
    Number(params.i) ||
    (kind === "month" ? thisMonth : kind === "quarter" ? Math.ceil(thisMonth / 3) : 1);

  let books;
  try {
    books = await getBooksSnapshot(kind, year, index);
  } catch {
    books = await getBooksSnapshot("month", thisYear, thisMonth);
  }

  // Payroll runs on the same calendar period as the P&L above it, so "still
  // owed" and "expenses" are always describing the same window.
  const payroll = await getPayrollSnapshot(
    getPeriodWindow(books.period.kind, books.period.year, books.period.index, books.timezone),
  );

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
    <div className="max-w-[88rem]">
      <FinanceWorkspaceHeader
        active="reports"
        title="Business overview"
        description="Start with profit and cash position, then move into the tax, sales, lead and capacity detail behind those numbers."
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#D8E1EA] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)]">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#0B2A4A] text-sm font-bold text-[#FFFFFF]">
              1
            </span>
            <div>
              <h2 className="text-sm font-bold text-[#0B2A4A]">Financial period</h2>
              <p className="mt-1 text-xs leading-5 text-[#697B8D]">
                Profit, expenses and payroll use a complete calendar month, quarter or year.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <PeriodNav
              period={{
                kind: books.period.kind,
                year: books.period.year,
                index: books.period.index,
                label: books.period.label,
              }}
              basePath="/admin/reports"
              extraParams={{ range: String(days) }}
            />
            <a
              href={`/api/reports/export?kind=pnl&kindPeriod=${books.period.kind}&y=${books.period.year}&i=${books.period.index}`}
              className={financeButton}
            >
              Export P&amp;L
            </a>
          </div>
        </section>

        <section className="rounded-2xl border border-[#D8E1EA] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)]">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#E0A93B] text-sm font-bold text-[#0B2A4A]">
              2
            </span>
            <div>
              <h2 className="text-sm font-bold text-[#0B2A4A]">Recent performance</h2>
              <p className="mt-1 text-xs leading-5 text-[#697B8D]">
                Revenue, leads, tax detail and utilization use a rolling window: {periodLabel}.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <nav
              aria-label="Recent performance window"
              className="flex rounded-xl border border-[#D4DEE7] bg-[#F5F7FA] p-1"
            >
              {REPORT_DAY_OPTIONS.map((option) => (
                <Link
                  key={option}
                  href={`/admin/reports?range=${option}&kind=${books.period.kind}&y=${books.period.year}&i=${books.period.index}`}
                  aria-current={days === option ? "page" : undefined}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    days === option
                      ? "bg-[#0B2A4A] text-[#FFFFFF] shadow-sm"
                      : "text-[#5F7285] hover:bg-white hover:text-[#0B2A4A]"
                  }`}
                >
                  {option} days
                </Link>
              ))}
            </nav>
            <details className="relative">
              <summary className={`${financeButton} cursor-pointer list-none`}>Export data</summary>
              <div className="absolute right-0 top-12 z-20 w-48 rounded-xl border border-[#D8E1EA] bg-white p-2 shadow-[0_14px_36px_rgba(11,42,74,0.16)]">
                {[
                  { kind: "summary", label: "Summary CSV" },
                  { kind: "invoices", label: "Invoices + tax CSV" },
                  { kind: "payments", label: "Payments CSV" },
                ].map((option) => (
                  <a
                    key={option.kind}
                    href={`/api/reports/export?kind=${option.kind}&range=${days}`}
                    className="block rounded-lg px-3 py-2 text-xs font-semibold text-[#425A70] hover:bg-[#F4F6FA] hover:text-[#0B2A4A]"
                  >
                    {option.label}
                  </a>
                ))}
              </div>
            </details>
          </div>
        </section>
      </div>

      <nav
        aria-label="Report sections"
        className="mt-4 flex gap-2 overflow-x-auto rounded-2xl border border-[#DEE5EC] bg-[#F8FAFC] p-2"
      >
        {[
          ["financial-summary", "Profit & loss"],
          ["tax-heading", "Tax & payments"],
          ["revenue-heading", "Revenue"],
          ["funnel-heading", "Leads"],
          ["utilization-heading", "Capacity"],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="min-w-max rounded-xl px-3 py-2 text-xs font-semibold text-[#526A80] hover:bg-white hover:text-[#0B2A4A]"
          >
            {label}
          </a>
        ))}
      </nav>

      <section
        id="financial-summary"
        aria-labelledby="pnl-heading"
        className="mt-6 rounded-[1.75rem] border border-[#DCE4EC] bg-[#F8FAFC] p-5 shadow-[0_10px_30px_rgba(11,42,74,0.045)] sm:p-6"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="pnl-heading" className="text-lg font-semibold text-white">
              Profit &amp; loss
            </h2>
            <p className="mt-1 text-xs text-ink-400">
              Sales are invoices issued in {books.period.label} — the same basis as the tax figures
              below, so the two always agree. Expenses count on the day they were paid.
            </p>
          </div>
          <p className="rounded-full bg-[#E9EEF3] px-3 py-1.5 text-xs font-semibold text-[#526A80]">
            {books.period.label}
          </p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Net sales"
            value={formatCents(books.pnl.netSalesCents, books.currency)}
            note={`${books.pnl.invoiceCount} ${books.pnl.invoiceCount === 1 ? "invoice" : "invoices"}, before ${settings.taxLabel}`}
          />
          <Kpi
            label="Expenses"
            value={formatCents(books.pnl.expenses.totalCents, books.currency)}
            note={`${books.pnl.expenses.count} ${books.pnl.expenses.count === 1 ? "payment" : "payments"} recorded`}
          />
          <Kpi
            label="Net profit"
            value={formatCents(books.pnl.netProfitCents, books.currency)}
            note={
              books.pnl.profitMargin === null
                ? "No sales in this period"
                : `${(books.pnl.profitMargin * 100).toFixed(1)}% margin`
            }
          />
          <Kpi
            label={`${settings.taxLabel} to remit`}
            value={formatCents(books.tax.netOwingCents, books.currency)}
            note={
              books.tax.netOwingCents < 0
                ? "Refund due — credits exceed tax collected"
                : `Collected less ${formatCents(books.tax.inputCreditCents, books.currency)} of credits`
            }
          />
        </div>

        {books.priorYear && (
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {books.period.label} compared with {books.priorYear.period.label}
              </caption>
              <thead className="bg-ink-900 text-left text-ink-400">
                <tr>
                  <th scope="col" className="px-4 py-3">Compared with last year</th>
                  <th scope="col" className="px-4 py-3 text-right">{books.priorYear.period.label}</th>
                  <th scope="col" className="px-4 py-3 text-right">{books.period.label}</th>
                  <th scope="col" className="px-4 py-3 text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Net sales", books.priorYear.pnl.netSalesCents, books.pnl.netSalesCents],
                    ["Expenses", books.priorYear.pnl.expenses.totalCents, books.pnl.expenses.totalCents],
                    ["Net profit", books.priorYear.pnl.netProfitCents, books.pnl.netProfitCents],
                  ] as const
                ).map(([rowLabel, before, after]) => (
                  <tr key={rowLabel} className="border-t border-ink-800">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                      {rowLabel}
                    </th>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(before, books.currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-white">
                      {formatCents(after, books.currency)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${
                        after - before < 0 ? "text-red-300" : "text-emerald-300"
                      }`}
                    >
                      {after - before >= 0 ? "+" : ""}
                      {formatCents(after - before, books.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <caption className="sr-only">Expenses by category for {books.period.label}</caption>
            <thead className="bg-ink-900 text-left text-ink-400">
              <tr>
                <th scope="col" className="px-4 py-3">Where the money went</th>
                <th scope="col" className="px-4 py-3 text-right">Payments</th>
                <th scope="col" className="px-4 py-3 text-right">{settings.taxLabel} paid</th>
                <th scope="col" className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {books.pnl.expenses.byCategory.length === 0 ? (
                <tr className="border-t border-ink-800">
                  <td colSpan={4} className="px-4 py-6 text-center text-ink-400">
                    No expenses recorded for {books.period.label}.{" "}
                    <Link href="/admin/expenses" className="text-accent-300 hover:underline">
                      Add one
                    </Link>
                    .
                  </td>
                </tr>
              ) : (
                books.pnl.expenses.byCategory.map((entry) => (
                  <tr key={entry.categoryId} className="border-t border-ink-800">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                      {entry.name}
                    </th>
                    <td className="px-4 py-3 text-right text-ink-300">{entry.count}</td>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(entry.taxPaidCents, books.currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-white">
                      {formatCents(entry.amountCents, books.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-700 bg-ink-900/60">
                <th scope="row" className="px-4 py-3 text-left font-semibold text-white">
                  Total
                </th>
                <td className="px-4 py-3 text-right text-ink-300">{books.pnl.expenses.count}</td>
                <td className="px-4 py-3 text-right text-ink-200">
                  {formatCents(books.pnl.expenses.inputTaxCreditCents, books.currency)}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-white">
                  {formatCents(books.pnl.expenses.totalCents, books.currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-4 rounded-xl border border-ink-800 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Payroll</h3>
              <p className="mt-1 text-xs text-ink-400">
                Wages earned in {books.period.label} against what has actually been paid out.
                Earned is hours logged plus monthly salaries; paid is the payroll slice of the
                expenses above, so it is already inside net profit.
              </p>
            </div>
            <Link
              href={`/admin/reports/payroll?kind=${books.period.kind}&y=${books.period.year}&i=${books.period.index}`}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-200 hover:bg-ink-800"
            >
              Open payroll report
            </Link>
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-400">Earned</dt>
              <dd className="mt-1 text-xl font-semibold text-white">
                {formatCents(payroll.payroll.totalEarnedCents, books.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-400">Paid out</dt>
              <dd className="mt-1 text-xl font-semibold text-white">
                {formatCents(payroll.payroll.paidCents, books.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-400">Variance</dt>
              <dd
                className={`mt-1 text-xl font-semibold ${
                  payroll.payroll.varianceCents > 0 ? "text-amber-300" : "text-white"
                }`}
              >
                {formatCents(payroll.payroll.varianceCents, books.currency)}
                <span className="ml-2 text-xs font-normal text-ink-400">
                  {payroll.payroll.varianceCents > 0
                    ? "still owed"
                    : payroll.payroll.varianceCents < 0
                      ? "paid ahead"
                      : "settled"}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="mt-8 overflow-hidden rounded-[1.75rem] bg-[#0B2A4A] px-5 py-6 text-[#FFFFFF] shadow-[0_12px_32px_rgba(11,42,74,0.14)] sm:px-7">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#E5BE67]">
          Recent performance · {days} days
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-[-0.02em]">Sales and operations</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-white/65">
              {periodLabel} · {report.timezone}. The sections below use this rolling window, not
              the calendar period used for profit and loss above.
            </p>
          </div>
          <a
            href="#financial-summary"
            className="rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2 text-xs font-semibold text-white/75 hover:bg-white/10 hover:text-white"
          >
            Back to financials ↑
          </a>
        </div>
      </div>

      <section
        aria-labelledby="tax-heading"
        className="mt-6 rounded-[1.75rem] border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="tax-heading" className="text-lg font-semibold text-white">
            Tax
          </h2>
          <p className="text-xs text-ink-400">
            Accrual basis: invoices issued in this period, drafts and cancellations excluded.
          </p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label={`${report.currency === "CAD" ? "HST" : "Tax"} collected`}
            value={formatCents(report.tax.taxCollectedCents, report.currency)}
            note={`On ${formatCents(report.tax.taxableBaseCents, report.currency)} of taxable sales`}
          />
          <Kpi
            label="Taxable sales"
            value={formatCents(report.tax.taxableBaseCents, report.currency)}
            note="Subtotal less discount, before tax"
          />
          <Kpi
            label="Non-taxed sales"
            value={formatCents(report.tax.exemptBaseCents, report.currency)}
            note={`${report.tax.exemptInvoiceCount} of ${report.tax.invoiceCount} invoices`}
          />
          <Kpi
            label="Invoices issued"
            value={String(report.tax.invoiceCount)}
            note="Sent, paid, overdue or refunded"
          />
          <Kpi
            label="Discounts given"
            value={formatCents(report.discounts.discountCents, report.currency)}
            note={
              report.discounts.discountRate !== null
                ? `${(report.discounts.discountRate * 100).toFixed(1)}% of sales, across ${report.discounts.invoiceCount} invoice${report.discounts.invoiceCount === 1 ? "" : "s"}`
                : "No invoices issued in this window"
            }
          />
        </div>
        {report.tax.exemptReasons.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-ink-700">
            <table className="w-full text-sm">
              <caption className="sr-only">Sales with no tax charged, by reason</caption>
              <thead className="bg-ink-900/60 text-xs uppercase tracking-wider text-ink-400">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left">Reason no tax was charged</th>
                  <th scope="col" className="px-4 py-3 text-right">Invoices</th>
                  <th scope="col" className="px-4 py-3 text-right">Sales</th>
                </tr>
              </thead>
              <tbody>
                {report.tax.exemptReasons.map((row) => (
                  <tr key={row.reason} className="border-t border-ink-800">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                      {row.reason}
                    </th>
                    <td className="px-4 py-3 text-right text-ink-300">{row.count}</td>
                    <td className="px-4 py-3 text-right text-white">
                      {formatCents(row.baseCents, report.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Spec §4.5, kept verbatim. The shop is an HST registrant, and a
            registrant owes HST on every taxable supply regardless of how the
            customer pays — so recording cash and e-transfer sales with no tax
            understates HST collected. The owner was told this and chose the
            literal rule anyway; the footnote is what carries that choice to
            whoever files the return. Do not remove it silently. */}
        <p className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-950/10 p-4 text-sm text-amber-200">
          Cash and Interac sales are recorded with no tax charged; confirm treatment with your
          accountant before filing.
        </p>
      </section>

      <section
        aria-labelledby="methods-heading"
        className="mt-6 rounded-[1.75rem] border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="methods-heading" className="text-lg font-semibold text-white">
            How customers paid
          </h2>
          <p className="text-xs text-ink-400">Cash basis, same window as revenue.</p>
        </div>
        {report.paymentMethods.length === 0 ? (
          <p className="mt-3 text-sm text-ink-400">No payments recorded in this period.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-ink-700">
            <table className="w-full text-sm">
              <caption className="sr-only">Net revenue by payment method</caption>
              <thead className="bg-ink-900/60 text-xs uppercase tracking-wider text-ink-400">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left">Method</th>
                  <th scope="col" className="px-4 py-3 text-right">Gross</th>
                  <th scope="col" className="px-4 py-3 text-right">Refunded</th>
                  <th scope="col" className="px-4 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {report.paymentMethods.map((row) => (
                  <tr key={row.provider} className="border-t border-ink-800">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
                      {PAYMENT_PROVIDER_LABELS[row.provider] ?? row.provider}
                    </th>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(row.grossCents, report.currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-ink-300">
                      {formatCents(row.refundCents, report.currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-white">
                      {formatCents(row.netCents, report.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        aria-labelledby="revenue-heading"
        className="mt-6 rounded-[1.75rem] border border-[#DCE4EC] bg-[#F8FAFC] p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
      >
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

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section
          aria-labelledby="funnel-heading"
          className="rounded-[1.75rem] border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
        >
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

        <section
          aria-labelledby="sources-heading"
          className="rounded-[1.75rem] border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
        >
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

      <section
        aria-labelledby="utilization-heading"
        className="mt-6 rounded-[1.75rem] border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6"
      >
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
