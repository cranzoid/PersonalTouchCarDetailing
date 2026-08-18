"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PeriodNav, type PeriodInfo } from "@/components/period-nav";
import { formatCents } from "@/lib/money";
import type { PayrollLine, PayrollSummary } from "@/lib/payroll";
import { EXPENSE_PAYMENT_METHODS, EXPENSE_PAYMENT_METHOD_LABELS, PAY_TYPE_LABELS, type ExpensePaymentMethod } from "@/lib/types";
import { createExpenseAction } from "../../expenses/actions";

const inputClass =
  "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white focus:border-accent-500 focus:outline-none";
const labelClass = "block text-xs font-medium text-ink-400";
const card = "rounded-2xl border border-ink-700 bg-ink-900/50 p-5";

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

  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Payroll</h1>
          <p className="mt-1 text-sm text-ink-400">
            What each person earned in {period.label}, what has already been paid out, and the
            balance still owed.
          </p>
          <p className="mt-1 text-xs text-ink-400">
            Earned comes from{" "}
            <Link href="/admin/timesheets" className="text-accent-300 hover:underline">
              hours logged
            </Link>{" "}
            plus monthly salaries. Paid comes from expenses in a payroll category, matched to the
            staff member on the expense — never on a typed name.
          </p>
        </div>
        <PeriodNav period={period} basePath="/admin/reports/payroll" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className={card}>
          <p className="text-sm text-ink-400">Earned</p>
          <p className="mt-1 text-3xl font-bold text-white">{money(payroll.totalEarnedCents)}</p>
          <p className="mt-2 text-xs text-ink-400">
            {money(payroll.earnedVariableCents)} from hours · {money(payroll.accruedFixedCents)}{" "}
            salary
          </p>
        </div>
        <div className={card}>
          <p className="text-sm text-ink-400">Paid out</p>
          <p className="mt-1 text-3xl font-bold text-white">{money(payroll.paidCents)}</p>
          <p className="mt-2 text-xs text-ink-400">Payroll expenses recorded in {period.label}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-ink-400">Still owed</p>
          <p
            className={`mt-1 text-3xl font-bold ${payroll.varianceCents > 0 ? "text-amber-300" : "text-white"}`}
          >
            {money(payroll.varianceCents)}
          </p>
          <p className="mt-2 text-xs text-ink-400">
            {payroll.varianceCents > 0
              ? "Earned but not yet paid"
              : payroll.varianceCents < 0
                ? "Paid ahead of what was earned"
                : "Fully settled"}
          </p>
        </div>
        <div className={card}>
          <p className="text-sm text-ink-400">Hours logged</p>
          <p className="mt-1 text-3xl font-bold text-white">
            {formatHours(payroll.lines.reduce((total, line) => total + line.minutes, 0))}
          </p>
          <p className="mt-2 text-xs text-ink-400">
            {payroll.lines.reduce((total, line) => total + line.daysWorked, 0)} days worked
          </p>
        </div>
      </div>

      {payroll.unassignedPaidCents > 0 && (
        <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-400/5 p-4 text-sm text-amber-200">
          {money(payroll.unassignedPaidCents)} of payroll expenses in {period.label} do not name a
          staff member, so they count in the total paid but sit on no line below.{" "}
          <Link href="/admin/expenses" className="underline underline-offset-2">
            Open Expenses
          </Link>{" "}
          and set who was paid.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
          Who is owed what
        </h2>
        {payroll.lines.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-ink-700 p-8 text-center text-sm text-ink-400">
            No staff accounts yet.{" "}
            <Link href="/admin/staff" className="text-accent-300 hover:underline">
              Add one
            </Link>{" "}
            and set their pay type and rate.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <caption className="sr-only">Payroll by staff member for {period.label}</caption>
              <thead className="bg-ink-900 text-left text-ink-400">
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
            className="whitespace-nowrap rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-200 hover:border-accent-500 hover:text-white"
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
            className="rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {busy ? "Recording…" : "Record payout"}
          </button>
        </div>
      </div>
    </div>
  );
}
