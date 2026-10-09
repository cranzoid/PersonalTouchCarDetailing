"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { applyMemberBenefitsAction } from "../actions";

/**
 * Shows the car's membership or Winter Pass at the counter and spends it on
 * this visit. Only benefits the booking actually contains are offered — the
 * wash needs the wash on the booking — so staff cannot discount the wrong line.
 */
export function MemberBenefitsPanel({
  appointmentId,
  membership,
  pass,
  applied,
  canApply,
}: {
  appointmentId: string;
  membership: null | {
    planName: string;
    status: string;
    discountPercent: number;
    benefits: { key: "wash" | "interior"; label: string; available: boolean; onBooking: boolean }[];
  };
  pass: null | { washesLeft: number; washesTotal: number; usableNow: boolean; washOnBooking: boolean };
  applied: string[];
  canApply: boolean;
}) {
  const router = useRouter();
  const usable = membership?.benefits.filter((b) => b.available && b.onBooking) ?? [];
  const [benefits, setBenefits] = useState<("wash" | "interior")[]>(usable.map((b) => b.key));
  const [passWash, setPassWash] = useState(Boolean(pass?.usableNow && pass.washOnBooking && usable.length === 0));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    setBusy(true);
    setMessage(null);
    const result = await applyMemberBenefitsAction({ appointmentId, benefits, passWash });
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: "Applied." } : { ok: false, text: result.error });
    if (result.ok) router.refresh();
  }

  return (
    <section className="mt-4 rounded-xl border border-accent-500/30 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-accent-300">Member benefits</h2>
      {membership && (
        <p className="mt-2 text-sm text-ink-200">
          {membership.planName}
          {membership.status === "past_due" ? (
            <span className="ml-2 text-red-300">payment overdue — benefits paused</span>
          ) : (
            <span className="ml-2 text-ink-400">· {membership.discountPercent}% off detailing packages and add-ons</span>
          )}
        </p>
      )}
      {membership?.benefits.map((benefit) => (
        <label key={benefit.key} className="mt-2 flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            disabled={!canApply || !benefit.available || !benefit.onBooking}
            checked={benefits.includes(benefit.key)}
            onChange={(e) => setBenefits((cur) => (e.target.checked ? [...cur, benefit.key] : cur.filter((k) => k !== benefit.key)))}
          />
          {benefit.label}
          <span className="text-xs text-ink-500">
            {!benefit.available ? "used this month" : !benefit.onBooking ? "not on this booking" : "available"}
          </span>
        </label>
      ))}
      {pass && (
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            disabled={!canApply || !pass.usableNow || !pass.washOnBooking}
            checked={passWash}
            onChange={(e) => setPassWash(e.target.checked)}
          />
          Winter Pass wash ({pass.washesLeft} of {pass.washesTotal} left)
          {!pass.usableNow && <span className="text-xs text-ink-500">outside the pass season</span>}
          {pass.usableNow && !pass.washOnBooking && <span className="text-xs text-ink-500">no wash on this booking</span>}
        </label>
      )}
      {applied.length > 0 && <p className="mt-3 text-xs text-emerald-300">Already used on this visit: {applied.join(", ")}.</p>}
      {canApply ? (
        <button
          type="button"
          disabled={busy || (benefits.length === 0 && !passWash && !(membership && membership.discountPercent > 0))}
          onClick={() => void apply()}
          className="mt-3 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
        >
          {busy ? "Applying…" : "Apply member benefits"}
        </button>
      ) : (
        <p className="mt-3 text-xs text-ink-500">This visit is invoiced or closed, so benefits can no longer be applied here.</p>
      )}
      {message && <p className={`mt-2 text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>}
    </section>
  );
}
