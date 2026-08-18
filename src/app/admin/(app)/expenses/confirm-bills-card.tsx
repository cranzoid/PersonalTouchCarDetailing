"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmBillsAction } from "./actions";

/**
 * Home-screen prompt for this month's automatically-created bills. Confirming
 * says "these amounts are right"; correcting one is a trip to Expenses, which
 * marks it confirmed on save.
 */
export function ConfirmBillsCard({
  bills,
}: {
  bills: { id: string; label: string; amountLabel: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmAll() {
    setBusy(true);
    setError(null);
    const result = await confirmBillsAction({ expenseIds: bills.map((bill) => bill.id) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <section className="mt-6 rounded-2xl border border-accent-500/40 bg-accent-400/5 p-5">
      <h2 className="text-lg font-semibold text-accent-300">
        {bills.length} {bills.length === 1 ? "bill" : "bills"} to confirm
      </h2>
      <p className="mt-1 text-sm text-ink-300">
        Added automatically from your monthly bills. Check the amounts are right.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-ink-200">
        {bills.map((bill) => (
          <li key={bill.id} className="flex justify-between gap-4">
            <span className="truncate">{bill.label}</span>
            <span className="shrink-0 font-medium text-white">{bill.amountLabel}</span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void confirmAll()}
          disabled={busy}
          className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
        >
          {busy ? "Confirming…" : "These are all correct"}
        </button>
        <Link
          href="/admin/expenses"
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500"
        >
          Change an amount
        </Link>
      </div>
    </section>
  );
}
