"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  giftMonthAction,
  retryMembershipChargeAction,
  schedulePlanChangeAction,
  staffCancelMembershipAction,
  staffResumeMembershipAction,
} from "../actions";

export function MemberActions({
  membershipId,
  status,
  cancelAtPeriodEnd,
  plans,
  defaultFromISO,
}: {
  membershipId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  plans: { id: string; name: string }[];
  defaultFromISO: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [toPlanId, setToPlanId] = useState(plans[0]?.id ?? "");
  const [fromDate, setFromDate] = useState(defaultFromISO);
  const input = "rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
  const button = "rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-40";

  async function run(fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, done?: string) {
    setBusy(true);
    setMessage(null);
    const result = await fn();
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: result.message ?? done ?? "Done." } : { ok: false, text: result.error });
    if (result.ok) router.refresh();
  }

  return (
    <section className="mt-8 space-y-5 rounded-xl border border-ink-800 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Actions</h2>
      <div className="flex flex-wrap gap-2">
        {status === "past_due" && (
          <button type="button" disabled={busy} className={button} onClick={() => void run(() => retryMembershipChargeAction(membershipId))}>
            Retry the charge now
          </button>
        )}
        {(status === "active" || status === "past_due") && (
          <button type="button" disabled={busy} className={button} onClick={() => void run(() => giftMonthAction(membershipId))}>
            {status === "past_due" ? "Forgive this month" : "Give a free month"}
          </button>
        )}
        {cancelAtPeriodEnd && (
          <button type="button" disabled={busy} className={button} onClick={() => void run(() => staffResumeMembershipAction(membershipId), "Cancellation withdrawn.")}>
            Undo cancellation
          </button>
        )}
      </div>

      {plans.length > 0 && (status === "active" || status === "past_due") && (
        <div className="border-t border-ink-800 pt-4">
          <p className="text-sm font-medium text-white">Move to another plan</p>
          <p className="mt-1 text-xs text-ink-500">
            Takes effect at the member&apos;s first billing date on or after the start date; they are told in advance. For an
            immediate upgrade the member uses their account.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <select className={input} value={toPlanId} onChange={(e) => setToPlanId(e.target.value)}>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" className={input} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <button type="button" disabled={busy || !toPlanId} className={button} onClick={() => void run(() => schedulePlanChangeAction({ membershipId, toPlanId, fromDate }))}>
              Schedule change
            </button>
            <button type="button" disabled={busy} className="text-xs text-ink-400 underline" onClick={() => void run(() => schedulePlanChangeAction({ membershipId, toPlanId: null, fromDate: null }))}>
              Clear scheduled change
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-ink-800 pt-4">
        <p className="text-sm font-medium text-white">Cancel</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input className={`${input} min-w-[16rem] flex-1`} placeholder="Reason (kept in the log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {status === "active" && !cancelAtPeriodEnd && (
            <button type="button" disabled={busy || !reason.trim()} className={button} onClick={() => void run(() => staffCancelMembershipAction({ membershipId, immediately: false, reason }), "Will end at the end of the paid month.")}>
              At end of paid month
            </button>
          )}
          <button type="button" disabled={busy || !reason.trim()} className="rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-40" onClick={() => void run(() => staffCancelMembershipAction({ membershipId, immediately: true, reason }), "Membership ended.")}>
            End now
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-500">Ending now does not refund anything; issue any refund from the month&apos;s invoice.</p>
      </div>
      {message && <p className={`text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>}
    </section>
  );
}
