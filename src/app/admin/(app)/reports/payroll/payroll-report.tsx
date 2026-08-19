"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FinanceMetric,
  FinanceWorkspaceHeader,
  financeButton,
  financeInput,
  financeLabel,
  financePrimaryButton,
} from "@/components/finance-workspace";
import { PeriodNav, type PeriodInfo } from "@/components/period-nav";
import { formatCents } from "@/lib/money";
import type { PayrollLine, PayrollSummary } from "@/lib/payroll";
import { EXPENSE_PAYMENT_METHODS, EXPENSE_PAYMENT_METHOD_LABELS, PAY_TYPE_LABELS, type ExpensePaymentMethod } from "@/lib/types";
import { createExpenseAction } from "../../expenses/actions";

const inputClass = financeInput;
const labelClass = financeLabel;

const formatHours = (minutes: number) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;

export function PayrollReport({
  period,
  today,
  currency,
  payroll,
  payrollCategories,
  canRecordPayout,
}: {
  period: PeriodInfo;
  today: string;
  currency: string;
  payroll: PayrollSummary;
  payrollCategories: { id: string; name: string }[];
  canRecordPayout: boolean;
}) {
  const money = (cents: number) => formatCents(cents, currency);
  const [payingStaffId, setPayingStaffId] = useState<string | null>(null);
  const totalMinutes = payroll.lines.reduce((total, line) => total + line.minutes, 0);
  const totalDays = payroll.lines.reduce((total, line) => total + line.daysWorked, 0);
  const settlementPercent =
    payroll.totalEarnedCents > 0
      ? Math.min(100, Math.max(0, (payroll.paidCents / payroll.totalEarnedCents) * 100))
      : payroll.paidCents > 0
        ? 100
        : 0;

  return (
    <div className="max-w-[88rem]">
      <FinanceWorkspaceHeader
        active="payroll"
        title="Payroll position"
        description="See what each person earned, what has already left the business, and the exact balance that still needs attention."
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#DCE4EC] bg-white p-4 shadow-[0_8px_24px_rgba(11,42,74,0.04)]">
        <PeriodNav period={period} basePath="/admin/reports/payroll" />
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/timesheets" className={financeButton}>
            Review hours
          </Link>
          <Link href="/admin/expenses" className={financeButton}>
            View payouts
          </Link>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-[1.2fr_repeat(3,minmax(0,1fr))]">
        <FinanceMetric
          label={payroll.varianceCents > 0 ? "Still owed" : payroll.varianceCents < 0 ? "Paid ahead" : "Payroll status"}
          value={money(Math.abs(payroll.varianceCents))}
          detail={
            payroll.varianceCents > 0
              ? "Earned but not yet paid"
              : payroll.varianceCents < 0
                ? "Paid beyond earnings in this period"
                : "Everyone is fully settled"
          }
          tone={payroll.varianceCents > 0 ? "warning" : payroll.varianceCents < 0 ? "danger" : "positive"}
          featured
        />
        <FinanceMetric
          label="Earned"
          value={money(payroll.totalEarnedCents)}
          detail={`${money(payroll.earnedVariableCents)} from time · ${money(payroll.accruedFixedCents)} salary`}
        />
        <FinanceMetric
          label="Paid out"
          value={money(payroll.paidCents)}
          detail={`Payroll expenses in ${period.label}`}
          tone="positive"
        />
        <FinanceMetric
          label="Hours logged"
          value={formatHours(totalMinutes)}
          detail={`${totalDays} ${totalDays === 1 ? "day" : "days"} worked`}
        />
      </div>

      <div className="mt-4 rounded-2xl border border-[#DCE4EC] bg-white p-4 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:px-5">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-semibold text-[#425A70]">Settlement progress</span>
          <span className="font-bold text-[#0B2A4A]">{settlementPercent.toFixed(0)}% of earnings paid</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[#E8EDF2]">
          <div className="h-full rounded-full bg-[#16805C]" style={{ width: `${settlementPercent}%` }} />
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[#718296]">
          Earned is saved hourly/day-rate work plus calendar-month salaries. Paid is payroll-category
          expenses matched to a staff account.
        </p>
      </div>

      {payroll.unassignedPaidCents > 0 && (
        <p className="mt-4 rounded-2xl border border-[#E1BB58] bg-[#FFF9E8] p-4 text-sm text-[#735514]">
          {money(payroll.unassignedPaidCents)} of payroll expenses in {period.label} do not name a
          staff member, so they count in the total paid but sit on no line below.{" "}
          <Link href="/admin/expenses" className="underline underline-offset-2">
            Open Expenses
          </Link>{" "}
          and set who was paid.
        </p>
      )}

      <section className="mt-6 rounded-2xl border border-[#DCE4EC] bg-white p-5 shadow-[0_8px_24px_rgba(11,42,74,0.04)] sm:p-6">
        <div>
          <h2 className="text-base font-bold text-[#0B2A4A]">Who is owed what</h2>
          <p className="mt-1 text-xs leading-5 text-[#6B7D90]">
            Positive balances need a payout. Recording one creates the same audited expense used by
            the expense ledger and P&amp;L.
          </p>
        </div>
        {payroll.lines.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-ink-700 p-8 text-center text-sm text-ink-400">
            No staff accounts yet.{" "}
            <Link href="/admin/staff" className="text-accent-300 hover:underline">
              Add one
            </Link>{" "}
            and set their pay type and rate.
          </p>
        ) : (
          <>
          <div className="mt-5 space-y-3 md:hidden">
            {payroll.lines.map((line) => (
              <StaffCard
                key={line.staffUserId}
                line={line}
                money={money}
                canRecordPayout={canRecordPayout && payrollCategories.length > 0}
                onPay={() => setPayingStaffId(line.staffUserId)}
              />
            ))}
          </div>
          <div className="mt-5 hidden overflow-x-auto rounded-xl border border-[#DFE6ED] md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Payroll by staff member for {period.label}</caption>
              <thead className="bg-[#F5F7FA] text-left text-[#64778A]">
                <tr>
                  <th scope="col" className="px-4 py-3">Staff member</th>
                  <th scope="col" className="px-4 py-3 text-right">Hours</th>
                  <th scope="col" className="px-4 py-3 text-right">Days</th>
                  <th scope="col" className="px-4 py-3 text-right">Earned</th>
                  <th scope="col" className="px-4 py-3 text-right">Paid</th>
                  <th scope="col" className="px-4 py-3 text-right">Balance</th>
                  <th scope="col" className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {payroll.lines.map((line) => (
                  <StaffRow
                    key={line.staffUserId}
                    line={line}
                    money={money}
                    canRecordPayout={canRecordPayout && payrollCategories.length > 0}
                    onPay={() => setPayingStaffId(line.staffUserId)}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-700 bg-ink-900/60">
                  <th scope="row" className="px-4 py-3 text-left font-semibold text-white">Total</th>
                  <td className="px-4 py-3 text-right text-ink-300">
                    {formatHours(payroll.lines.reduce((total, line) => total + line.minutes, 0))}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-300">
                    {payroll.lines.reduce((total, line) => total + line.daysWorked, 0)}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-200">{money(payroll.totalEarnedCents)}</td>
                  <td className="px-4 py-3 text-right text-ink-200">{money(payroll.paidCents)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-white">
                    {money(payroll.varianceCents)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          </>
        )}
        {canRecordPayout && payrollCategories.length === 0 && (
          <p className="mt-3 text-xs text-amber-300">
            No active payroll expense category, so payouts cannot be recorded.{" "}
            <Link href="/admin/settings/bookkeeping" className="underline underline-offset-2">
              Mark one as payroll
            </Link>
            .
          </p>
        )}
      </section>

      {payingStaffId && (
        <RecordPayout
          line={payroll.lines.find((line) => line.staffUserId === payingStaffId)!}
          today={today}
          currency={currency}
          categories={payrollCategories}
          onClose={() => setPayingStaffId(null)}
        />
      )}
    </div>
  );
}

function StaffCard({
  line,
  money,
  canRecordPayout,
  onPay,
}: {
  line: PayrollLine;
  money: (cents: number) => string;
  canRecordPayout: boolean;
  onPay: () => void;
}) {
  return (
    <article
      className={`rounded-2xl border p-4 ${
        line.balanceCents > 0
          ? "border-[#E3C06A] bg-[#FFFBF0]"
          : "border-[#DFE6ED] bg-[#F9FBFC]"
      } ${line.active ? "" : "opacity-65"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-[#0B2A4A]">{line.name}</h3>
          <p className="mt-0.5 text-[11px] font-semibold text-[#718296]">
            {PAY_TYPE_LABELS[line.payType]}{line.active ? "" : " · inactive"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#7A8998]">Balance</p>
          <p className={`mt-0.5 text-lg font-bold ${line.balanceCents > 0 ? "text-[#8A6113]" : "text-[#0B2A4A]"}`}>
            {money(line.balanceCents)}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-black/5 bg-white/75 p-3">
        <div><dt className="text-[10px] uppercase tracking-wider text-[#82909E]">Hours</dt><dd className="mt-0.5 text-sm font-semibold text-[#344E65]">{line.payType === "monthly_fixed" && line.minutes === 0 ? "—" : formatHours(line.minutes)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[#82909E]">Days</dt><dd className="mt-0.5 text-sm font-semibold text-[#344E65]">{line.daysWorked || "—"}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[#82909E]">Earned</dt><dd className="mt-0.5 text-sm font-semibold text-[#344E65]">{money(line.earnedCents)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[#82909E]">Paid</dt><dd className="mt-0.5 text-sm font-semibold text-[#344E65]">{money(line.paidCents)}</dd></div>
      </dl>
      {canRecordPayout && line.balanceCents > 0 && (
        <button type="button" onClick={onPay} className={`${financePrimaryButton} mt-3 w-full`}>
          Record payout
        </button>
      )}
    </article>
  );
}

function StaffRow({
  line,
  money,
  canRecordPayout,
  onPay,
}: {
  line: PayrollLine;
  money: (cents: number) => string;
  canRecordPayout: boolean;
  onPay: () => void;
}) {
  return (
    <tr className={`border-t border-ink-800 ${line.active ? "" : "opacity-60"}`}>
      <th scope="row" className="px-4 py-3 text-left font-medium text-ink-200">
        {line.name}
        <span className="block text-xs font-normal text-ink-500">
          {PAY_TYPE_LABELS[line.payType]}
          {line.active ? "" : " · inactive"}
        </span>
      </th>
      <td className="px-4 py-3 text-right text-ink-300">
        {line.payType === "monthly_fixed" && line.minutes === 0 ? "—" : formatHours(line.minutes)}
      </td>
      <td className="px-4 py-3 text-right text-ink-300">{line.daysWorked || "—"}</td>
      <td className="px-4 py-3 text-right text-white">{money(line.earnedCents)}</td>
      <td className="px-4 py-3 text-right text-ink-300">{money(line.paidCents)}</td>
      <td
        className={`px-4 py-3 text-right font-semibold ${line.balanceCents > 0 ? "text-amber-300" : "text-ink-300"}`}
      >
        {money(line.balanceCents)}
      </td>
      <td className="px-4 py-3 text-right">
        {canRecordPayout && line.balanceCents > 0 && (
          <button
            type="button"
            onClick={onPay}
            className={financeButton}
          >
            Record payout
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * Pays the balance without leaving the report.
 *
 * This writes a normal expense through createExpenseAction — the same path the
 * Expenses screen uses, with the same validation and audit trail. There is
 * deliberately no second expense-insert path: in the spreadsheet the owner had
 * to read an instruction line and go type the payout on another tab, and that
 * round trip is exactly the friction that kills adoption.
 */
function RecordPayout({
  line,
  today,
  currency,
  categories,
  onClose,
}: {
  line: PayrollLine;
  today: string;
  currency: string;
  categories: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState((line.balanceCents / 100).toFixed(2));
  const [expenseDate, setExpenseDate] = useState(today);
  const [paidBy, setPaidBy] = useState<ExpensePaymentMethod>("etransfer");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const cents = Math.round(Number(amount) * 100);
    const result = await createExpenseAction({
      expenseDate,
      categoryId,
      paidTo: line.name,
      staffUserId: line.staffUserId,
      description: `Payroll — ${line.name}`,
      amountCents: Number.isFinite(cents) ? cents : 0,
      // Wages are not a taxable supply to the business, so a payout claims no
      // input tax credit. Source deductions are the owner's accountant's job.
      taxPaidCents: 0,
      paidBy,
      reference,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payout-heading"
        className="w-full max-w-lg rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-xl"
      >
        <h2 id="payout-heading" className="text-lg font-semibold text-white">
          Record a payout to {line.name}
        </h2>
        <p className="mt-1 text-xs text-ink-400">
          Creates an expense in a payroll category, which is what the balance above is measured
          against. Balance owed: {formatCents(line.balanceCents, currency)}.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            Date paid
            <input
              type="date"
              value={expenseDate}
              onChange={(event) => setExpenseDate(event.target.value)}
              className={`${inputClass} mt-1`}
            />
          </label>
          <label className={labelClass}>
            Amount
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={`${inputClass} mt-1`}
            />
          </label>
          <label className={labelClass}>
            Category
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={`${inputClass} mt-1`}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Paid by
            <select
              value={paidBy}
              onChange={(event) => setPaidBy(event.target.value as ExpensePaymentMethod)}
              className={`${inputClass} mt-1`}
            >
              {EXPENSE_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {EXPENSE_PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            Reference (cheque or transfer number)
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              className={`${inputClass} mt-1`}
            />
          </label>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className={financePrimaryButton}
          >
            {busy ? "Recording…" : "Record payout"}
          </button>
        </div>
      </div>
    </div>
  );
}
