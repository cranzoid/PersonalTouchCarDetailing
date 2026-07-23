"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, taxCents } from "@/lib/money";
import { decideEstimateAction } from "./actions";

type Line = {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  isOptional: boolean;
  isSelected: boolean;
};

export function ApprovalForm({
  token,
  lines,
  discountCents,
  taxRateBp,
  taxLabel,
  depositRequiredCents,
}: {
  token: string;
  lines: Line[];
  discountCents: number;
  taxRateBp: number;
  taxLabel: string;
  depositRequiredCents: number;
}) {
  const idPrefix = useId();
  const router = useRouter();
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(lines.filter((l) => l.isOptional && l.isSelected).map((l) => l.id)),
  );
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const subtotal = lines
      .filter((l) => !l.isOptional || chosen.has(l.id))
      .reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
    const disc = Math.min(discountCents, subtotal);
    const tax = taxCents(subtotal - disc, taxRateBp);
    return { subtotal, disc, tax, total: subtotal - disc + tax };
  }, [lines, chosen, discountCents, taxRateBp]);

  async function decide(decision: "approve" | "decline") {
    if (!name.trim()) {
      setError("Please type your name — it acts as your signature.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await decideEstimateAction({
      token,
      decision,
      name: name.trim(),
      selectedOptionalLineIds: [...chosen],
      message: message.trim() || undefined,
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.error);
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="overflow-x-auto rounded-2xl border border-ink-700 bg-ink-900/60 p-4 shadow-xl shadow-black/10 sm:p-6">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <caption className="sr-only">Estimate line items with optional selections and updated totals</caption>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-ink-800/60">
                <td className="py-2.5 pr-4 text-ink-200">
                  {l.isOptional ? (
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1">
                      <input
                        type="checkbox"
                        className="size-5 shrink-0 accent-[#E0A93B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                        checked={chosen.has(l.id)}
                        onChange={(e) => {
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(l.id);
                            else next.delete(l.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        {l.description}
                        {l.quantity > 1 && <span className="text-ink-500"> × {l.quantity}</span>}
                        <span className="ml-2 rounded-full bg-ink-800 px-2 py-0.5 text-xs text-accent-300">optional</span>
                      </span>
                    </label>
                  ) : (
                    <>
                      {l.description}
                      {l.quantity > 1 && <span className="text-ink-500"> × {l.quantity}</span>}
                    </>
                  )}
                </td>
                <td className="py-2.5 text-right text-ink-200">
                  {formatCents(l.quantity * l.unitPriceCents)}
                </td>
              </tr>
            ))}
            <tr><td className="py-2 pr-4 text-right text-ink-400">Subtotal</td>
              <td className="py-2 text-right text-ink-200">{formatCents(totals.subtotal)}</td></tr>
            {totals.disc > 0 && (
              <tr><td className="py-2 pr-4 text-right text-ink-400">Discount</td>
                <td className="py-2 text-right text-ink-200">−{formatCents(totals.disc)}</td></tr>
            )}
            <tr><td className="py-2 pr-4 text-right text-ink-400">{taxLabel} ({(taxRateBp / 100).toFixed(2)}%)</td>
              <td className="py-2 text-right text-ink-200">{formatCents(totals.tax)}</td></tr>
            <tr><td className="py-3 pr-4 text-right font-semibold text-white">Total</td>
              <td className="py-3 text-right text-lg font-semibold text-accent-300">{formatCents(totals.total)}</td></tr>
            {depositRequiredCents > 0 && (
              <tr><td className="py-2 pr-4 text-right text-ink-400">Deposit due at booking</td>
                <td className="py-2 text-right text-ink-200">{formatCents(depositRequiredCents)}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-5 shadow-xl shadow-black/15 sm:p-6">
        <label htmlFor={`${idPrefix}-signature`} className="block text-sm font-medium text-ink-200">
          Your full name (this is your signature)
          <input
            id={`${idPrefix}-signature`}
            autoComplete="name"
            className="mt-2 min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/70 px-4 py-2.5 text-sm text-white placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
          />
        </label>
        <label htmlFor={`${idPrefix}-message`} className="mt-4 block text-sm font-medium text-ink-200">
          Questions or change requests (optional)
          <textarea
            id={`${idPrefix}-message`}
            className="mt-2 w-full rounded-xl border border-ink-600 bg-ink-950/70 px-4 py-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {error && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={() => decide("approve")}
            disabled={busy}
            className="min-h-11 rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Working…" : `Approve — ${formatCents(totals.total)}`}
          </button>
          <button
            onClick={() => decide("decline")}
            disabled={busy}
            className="min-h-11 rounded-xl border border-ink-600 px-6 py-3 text-sm text-ink-200 hover:border-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Decline
          </button>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          By approving you accept the listed work and pricing. Final invoice may adjust only with
          your separate approval of any additional work.
        </p>
      </div>
    </div>
  );
}
