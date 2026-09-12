"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { redeemOfferClaimAction } from "../../marketing/offer-claims/actions";

export type AppointmentOfferClaim = {
  id: string;
  code: string;
  offerLabel: string;
  /** Already-recorded plate, normalized. Present once the offer has been spent. */
  redeemedPlate: string | null;
  redeemedLabel: string | null;
  /** Plate already on the vehicle record, offered as the obvious default. */
  vehiclePlate: string | null;
};

const inputClass =
  "min-h-11 w-full rounded-xl border border-[#D5DEE7] bg-white px-3 font-mono text-base uppercase tracking-widest text-[#1C2026] outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-[#9AA8B6] focus-visible:border-[#0B2A4A] focus-visible:ring-2 focus-visible:ring-[#E0A93B]";

/**
 * The counter check for a promotional wash.
 *
 * The licence plate is never asked for online — a plate typed by a stranger
 * proves nothing, and asking for one costs claims. It is entered here, with the
 * car in front of the person typing, and a plate that has already had its
 * promotional wash is refused outright.
 *
 * What it does NOT do is change the price. If the plate is refused, staff
 * reprice the booking through "Change packages", which is already audited and
 * already the one place a booking's money moves.
 */
export function OfferRedemptionPanel({ claim }: { claim: AppointmentOfferClaim }) {
  const router = useRouter();
  const [plate, setPlate] = useState(claim.vehiclePlate ?? "");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (claim.redeemedPlate) {
    return (
      <section className="mt-6 rounded-xl border border-emerald-700/40 bg-emerald-950/10 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">
          {claim.offerLabel}
        </h2>
        <p className="mt-2 text-sm text-ink-200">
          Redeemed against plate{" "}
          <span className="font-mono font-bold text-emerald-700">{claim.redeemedPlate}</span>
          {claim.redeemedLabel ? ` on ${claim.redeemedLabel}` : ""}. Code {claim.code}.
        </p>
        <p className="mt-1 text-xs text-ink-500">
          This plate cannot receive the promotional price again.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-xl border border-[#E0A93B]/50 bg-[#FBF6EC] p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[#8A681F]">
        {claim.offerLabel} — record the plate
      </h2>
      <p className="mt-2 text-sm text-[#42536A]">
        This booking is using promotional code{" "}
        <span className="font-mono font-bold text-[#0B2A4A]">{claim.code}</span>. Enter the licence
        plate when the vehicle arrives. One promotional wash per plate.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start">
        <label className="flex-1">
          <span className="sr-only">Licence plate</span>
          <input
            className={inputClass}
            value={plate}
            onChange={(event) => setPlate(event.target.value)}
            placeholder="Licence plate"
            maxLength={20}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          disabled={pending || plate.trim().length < 2}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#0B2A4A] px-5 text-sm font-semibold text-white admin-on-dark transition hover:bg-[#123B63] disabled:opacity-40"
          onClick={() =>
            start(async () => {
              const res = await redeemOfferClaimAction({ claimId: claim.id, plate });
              setMessage(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
              if (res.ok) router.refresh();
            })
          }
        >
          {pending ? "Checking…" : "Redeem offer"}
        </button>
      </div>

      {message && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-3 rounded-xl border p-3 text-sm leading-6 ${
            message.ok
              ? "border-emerald-700/40 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 font-medium text-red-800"
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
