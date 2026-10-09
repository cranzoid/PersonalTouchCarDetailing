"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HelcimCheckoutButton } from "@/components/helcim-checkout";
import type { AccountMembership } from "@/lib/accounts/overview";
import {
  cancelMembershipAction,
  confirmAccountPaymentAction,
  keepMembershipAction,
  startCardUpdateAction,
  upgradeMembershipAction,
} from "./actions";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400";

export function MembershipCard({ membership }: { membership: AccountMembership }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "cancel" | { planId: string; name: string; differenceLabel: string }>(null);
  const [showCard, setShowCard] = useState(membership.status === "past_due");

  async function run(fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await fn();
    setBusy(false);
    setConfirming(null);
    if (!result.ok) return setError(result.error);
    if (result.message) setMessage(result.message);
    router.refresh();
  }

  const pastDue = membership.status === "past_due";
  return (
    <article className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-xl shadow-black/15 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-300">{membership.planName}</p>
          <h3 className="mt-1 text-xl font-bold text-white">{membership.vehicleLabel}</h3>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            pastDue ? "bg-red-500/15 text-red-200" : membership.cancelAtPeriodEnd ? "bg-amber-500/15 text-amber-200" : "bg-emerald-500/15 text-emerald-200"
          }`}
        >
          {pastDue ? "Payment needed" : membership.cancelAtPeriodEnd ? "Cancelled — ends soon" : "Active"}
        </span>
      </div>

      {pastDue ? (
        <p className="mt-4 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-200">
          We couldn&apos;t collect this month&apos;s payment, so your benefits are paused. Update your card and we&apos;ll
          try again right away.
        </p>
      ) : (
        <ul className="mt-5 grid gap-2 sm:grid-cols-2">
          {membership.benefits.map((benefit) => (
            <li key={benefit.key} className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-950/40 px-4 py-3 text-sm">
              <span className="text-ink-200">{benefit.label}</span>
              <span className={benefit.available ? "font-semibold text-emerald-300" : "text-ink-500"}>
                {benefit.available ? "Available" : "Used this month"}
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-950/40 px-4 py-3 text-sm sm:col-span-2">
            <span className="text-ink-200">Member discount on detailing &amp; add-ons</span>
            <span className="font-semibold text-accent-300">{membership.discountPercent}% off</span>
          </li>
        </ul>
      )}

      <dl className="mt-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3 sm:block">
          <dt className="text-ink-400">{membership.cancelAtPeriodEnd ? "Benefits until" : "Renews"}</dt>
          <dd className="text-white">{membership.periodEndLabel ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3 sm:block">
          <dt className="text-ink-400">Monthly</dt>
          <dd className="text-white">{membership.priceLabel} incl. tax</dd>
        </div>
        <div className="flex justify-between gap-3 sm:block">
          <dt className="text-ink-400">Card</dt>
          <dd className="text-white">{membership.cardLabel ?? "On file"}</dd>
        </div>
        {membership.nextPlanName && (
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-ink-400">Changing to</dt>
            <dd className="text-white">
              {membership.nextPlanName} from {membership.nextPlanFromLabel}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-6 flex flex-wrap gap-2">
        {!pastDue && membership.benefits.some((b) => b.available) && (
          <a
            href={`/account/book?vehicle=${membership.vehicleId}&use=member`}
            className={`inline-flex min-h-11 items-center rounded-xl bg-accent-400 px-5 text-sm font-semibold text-ink-950 hover:bg-accent-300 ${focusRing}`}
          >
            Book my member visit
          </a>
        )}
        {!pastDue && (
          <a
            href={`/account/book?vehicle=${membership.vehicleId}&use=package`}
            className={`inline-flex min-h-11 items-center rounded-xl border border-accent-400/60 px-5 text-sm font-semibold text-accent-200 hover:bg-accent-400/10 ${focusRing}`}
          >
            Book a detail at {membership.discountPercent}% off
          </a>
        )}
        <button
          type="button"
          onClick={() => setShowCard((v) => !v)}
          className={`min-h-11 rounded-xl border border-ink-600 px-4 text-sm text-ink-100 hover:bg-ink-800 ${focusRing}`}
        >
          Update card
        </button>
        {membership.upgrades.map((upgrade) => (
          <button
            key={upgrade.planId}
            type="button"
            disabled={busy}
            onClick={() => setConfirming(upgrade)}
            className={`min-h-11 rounded-xl border border-ink-600 px-4 text-sm text-ink-100 hover:bg-ink-800 disabled:opacity-40 ${focusRing}`}
          >
            Upgrade to {upgrade.name}
          </button>
        ))}
        {membership.cancelAtPeriodEnd ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => keepMembershipAction(membership.id))}
            className={`min-h-11 rounded-xl border border-emerald-500/40 px-4 text-sm text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40 ${focusRing}`}
          >
            Keep my membership
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming("cancel")}
            className={`min-h-11 rounded-xl px-4 text-sm text-ink-400 underline-offset-4 hover:text-ink-200 hover:underline disabled:opacity-40 ${focusRing}`}
          >
            Cancel membership
          </button>
        )}
      </div>

      {confirming === "cancel" && (
        <div role="alertdialog" aria-label="Cancel membership" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-950/20 p-4 text-sm text-amber-100">
          <p>
            {pastDue
              ? "Your membership will end now. The unpaid month won't be charged."
              : `You won't be charged again. Your benefits continue until ${membership.periodEndLabel}. Payments already made aren't refunded.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => cancelMembershipAction(membership.id))}
              className={`min-h-11 rounded-xl bg-amber-300 px-4 font-semibold text-ink-950 disabled:opacity-40 ${focusRing}`}
            >
              {busy ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button type="button" onClick={() => setConfirming(null)} className={`min-h-11 rounded-xl border border-ink-600 px-4 text-ink-100 ${focusRing}`}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {confirming && confirming !== "cancel" && (
        <div role="alertdialog" aria-label="Upgrade membership" className="mt-4 rounded-xl border border-accent-400/30 bg-[#0B2A4A]/60 p-4 text-sm text-ink-100">
          <p>
            Upgrade to {confirming.name} now? We&apos;ll charge {confirming.differenceLabel} (incl. tax) to your card today for the
            difference, and your new benefits start straight away.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => upgradeMembershipAction(membership.id, confirming.planId))}
              className={`min-h-11 rounded-xl bg-accent-400 px-4 font-semibold text-ink-950 disabled:opacity-40 ${focusRing}`}
            >
              {busy ? "Upgrading…" : `Upgrade for ${confirming.differenceLabel}`}
            </button>
            <button type="button" onClick={() => setConfirming(null)} className={`min-h-11 rounded-xl border border-ink-600 px-4 text-ink-100 ${focusRing}`}>
              Not now
            </button>
          </div>
        </div>
      )}
      {showCard && (
        <div className="mt-4 rounded-xl border border-ink-700 bg-ink-950/40 p-4">
          <p className="mb-3 text-sm text-ink-300">Enter the new card. It becomes the card for your membership.</p>
          <HelcimCheckoutButton
            label="Save a new card"
            start={startCardUpdateAction.bind(null, membership.id)}
            confirm={confirmAccountPaymentAction}
            successMessage={pastDue ? "Card saved — we're retrying your payment now." : "Card saved."}
          />
        </div>
      )}
      {message && <p role="status" className="mt-4 text-sm text-emerald-300">{message}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    </article>
  );
}
