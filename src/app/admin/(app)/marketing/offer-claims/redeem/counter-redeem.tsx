"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SearchSelect, type SearchSelectOption } from "@/components/search-select";
import { card, heading, label, primaryButton, secondaryButton, subtle } from "../../ui";
import { findOfferClaimAction, redeemWalkInClaimAction, type ClaimLookupResult } from "../actions";

type FoundClaim = Extract<ClaimLookupResult, { ok: true }>["claim"];

const STATUS: Record<string, { label: string; tone: string }> = {
  issued: { label: "Valid — not booked", tone: "bg-[#E7F2EA] text-emerald-800" },
  booked: { label: "Booked", tone: "bg-[#E7F2EA] text-emerald-800" },
  redeemed: { label: "Already used", tone: "bg-[#0B2A4A] text-white admin-on-dark" },
  expired: { label: "Expired", tone: "bg-[#F7EFE2] text-[#8A681F]" },
  void: { label: "Released", tone: "bg-[#F6E9E9] text-red-800" },
};

const plateClass =
  "mt-1.5 min-h-11 w-full rounded-xl border border-[#D5DEE7] bg-white px-3 font-mono text-base uppercase tracking-widest text-[#1C2026] outline-none placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-[#9AA8B6] focus-visible:border-[#0B2A4A] focus-visible:ring-2 focus-visible:ring-[#E0A93B]";

export function CounterRedeem({
  customers,
  canCreateCustomer,
  canInvoice,
}: {
  customers: SearchSelectOption[];
  canCreateCustomer: boolean;
  canInvoice: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [claim, setClaim] = useState<FoundClaim | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, startLookup] = useTransition();

  function lookup(event: FormEvent) {
    event.preventDefault();
    startLookup(async () => {
      setLookupError(null);
      const result = await findOfferClaimAction({ code });
      if (result.ok) {
        setClaim(result.claim);
      } else {
        setClaim(null);
        setLookupError(result.error);
      }
    });
  }

  return (
    <>
      <section className={`mt-6 ${card}`}>
        <h2 className={heading}>1. Check the code</h2>
        <form onSubmit={lookup} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className={`flex-1 ${label}`}>
            Code from their text or email
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="PTW-7QK2MB"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className={plateClass}
            />
          </label>
          <button type="submit" disabled={looking || code.trim().length < 3} className={primaryButton}>
            {looking ? "Checking…" : "Check code"}
          </button>
        </form>
        {lookupError && (
          <p role="alert" className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800">
            {lookupError}
          </p>
        )}
      </section>

      {claim && (
        <ClaimPanel
          // Remount per claim so a half-filled form never carries over.
          key={claim.id}
          claim={claim}
          customers={customers}
          canCreateCustomer={canCreateCustomer}
          canInvoice={canInvoice}
          onRedeemed={() => router.refresh()}
        />
      )}
    </>
  );
}

function ClaimPanel({
  claim,
  customers,
  canCreateCustomer,
  canInvoice,
  onRedeemed,
}: {
  claim: FoundClaim;
  customers: SearchSelectOption[];
  canCreateCustomer: boolean;
  canInvoice: boolean;
  onRedeemed: () => void;
}) {
  const usable = claim.status !== "redeemed" && claim.status !== "void";
  const defaultChoice = claim.customerId
    ? "none"
    : claim.matches[0]
      ? claim.matches[0].id
      : canCreateCustomer
        ? "new"
        : "other";
  const [plate, setPlate] = useState("");
  const [choice, setChoice] = useState<string>(defaultChoice);
  const [otherCustomer, setOtherCustomer] = useState("");
  const [honourExpired, setHonourExpired] = useState(false);
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<
    | { ok: true; message: string; customerId: string | null; createdCustomer: boolean }
    | { ok: false; error: string; customerId?: string | null; createdCustomer?: boolean }
    | null
  >(null);

  const customer = choice === "other" ? otherCustomer : choice;
  const ready =
    plate.trim().length >= 2 &&
    (choice !== "other" || otherCustomer !== "") &&
    (claim.status !== "expired" || honourExpired);

  function redeem() {
    start(async () => {
      const result = await redeemWalkInClaimAction({
        claimId: claim.id,
        plate,
        customer,
        honourExpired,
      });
      setOutcome(result);
      if (result.ok || result.createdCustomer) onRedeemed();
    });
  }

  const done = outcome?.ok === true;
  const status = done
    ? { label: "Redeemed", tone: "bg-[#0B2A4A] text-white admin-on-dark" }
    : (STATUS[claim.status] ?? { label: claim.status, tone: "bg-[#EEF2F7] text-[#42536A]" });

  return (
    <section className={`mt-6 ${card}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-lg font-bold tracking-wider text-[#0B2A4A]">{claim.code}</p>
          <p className="mt-0.5 text-base font-semibold text-[#25313F]">{claim.name}</p>
          <p className={subtle}>{[claim.phone, claim.email].filter(Boolean).join(" · ")}</p>
          <p className={subtle}>
            Claimed {claim.claimedLabel} · {claim.status === "expired" ? "expired" : "valid until"} {claim.expiresLabel}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.tone}`}>{status.label}</span>
      </div>

      {claim.status === "redeemed" && (
        <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800">
          This code was already used on plate <span className="font-mono font-bold">{claim.plate}</span>
          {claim.redeemedLabel ? ` on ${claim.redeemedLabel}` : ""}. Charge the regular price.
        </p>
      )}
      {claim.status === "void" && (
        <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800">
          This code was released and cannot be used. Charge the regular price.
        </p>
      )}
      {claim.status === "booked" && claim.appointmentId && (
        <p className="mt-4 rounded-xl border border-[#D5DEE7] bg-[#F9FBFC] p-3 text-sm text-[#42536A]">
          Booked for {claim.appointmentLabel ?? "an appointment"}.{" "}
          <Link href={`/admin/appointments/${claim.appointmentId}`} className="font-semibold text-[#8A681F] hover:underline">
            Open the appointment
          </Link>{" "}
          — the price is already on it. You can record the plate there or here.
        </p>
      )}
      {claim.status === "expired" && !done && (
        <div className="mt-4 rounded-xl border border-[#E7C878] bg-[#FFF9E9] p-3 text-sm text-[#7A5F1E]">
          <p>This code ran out on {claim.expiresLabel}. The offer terms say it is no longer valid.</p>
          <label className="mt-2 flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={honourExpired}
              onChange={(event) => setHonourExpired(event.target.checked)}
            />
            Honour it anyway
          </label>
        </div>
      )}
      {usable && !done && claim.matches.length > 0 && !claim.customerId && (
        <div className="mt-4 rounded-xl border border-[#E7C878] bg-[#FFF9E9] p-3 text-sm text-[#7A5F1E]">
          <p className="font-semibold">Already on file with this phone number or email:</p>
          <ul className="mt-1 space-y-0.5">
            {claim.matches.map((match) => (
              <li key={match.id}>
                <Link href={`/admin/customers/${match.id}`} className="font-semibold underline">
                  {match.label}
                </Link>{" "}
                — {match.detail}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs">
            The offer is for new customers. If that record is the one you just created for this visit,
            carry on; if they have been here before, charge the regular price.
          </p>
        </div>
      )}

      {usable && !done && (
        <>
          <h2 className={`mt-6 ${heading}`}>2. Record the plate</h2>
          <label className={`mt-2 block ${label}`}>
            Licence plate of the car being washed
            <input
              value={plate}
              onChange={(event) => setPlate(event.target.value)}
              placeholder="Licence plate"
              maxLength={20}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className={plateClass}
            />
          </label>

          <h2 className={`mt-6 ${heading}`}>3. Link the customer</h2>
          {claim.customerId ? (
            <p className={`mt-2 ${subtle}`}>
              Already linked to{" "}
              <Link href={`/admin/customers/${claim.customerId}`} className="font-semibold text-[#8A681F] hover:underline">
                the customer from the booking
              </Link>
              .
            </p>
          ) : (
            <fieldset className="mt-2 space-y-2">
              <legend className="sr-only">Customer</legend>
              {claim.matches.map((match) => (
                <Choice key={match.id} value={match.id} current={choice} onChange={setChoice}>
                  Link to <strong>{match.label}</strong>
                </Choice>
              ))}
              {canCreateCustomer && (
                <Choice value="new" current={choice} onChange={setChoice}>
                  Create a new customer from this claim
                  <span className="block text-xs font-normal text-[#5A6B7D]">
                    {claim.name} · {[claim.phone, claim.email].filter(Boolean).join(" · ")} — add the vehicle on
                    their page afterwards.
                  </span>
                </Choice>
              )}
              <Choice value="other" current={choice} onChange={setChoice}>
                Someone else already on file
              </Choice>
              {choice === "other" && (
                <div className="pl-7">
                  <SearchSelect
                    label="Customer"
                    options={customers}
                    value={otherCustomer}
                    onChange={setOtherCustomer}
                    placeholder="Select customer…"
                    searchPlaceholder="Search name, phone, email or plate"
                  />
                </div>
              )}
              <Choice value="none" current={choice} onChange={setChoice}>
                Don&apos;t link a customer
              </Choice>
            </fieldset>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button type="button" disabled={!ready || pending} onClick={redeem} className={primaryButton}>
              {pending ? "Checking plate…" : "Redeem code"}
            </button>
            {claim.priceLabel && (
              <p className={subtle}>Offer price to charge for the wash: <strong>{claim.priceLabel}</strong></p>
            )}
          </div>
        </>
      )}

      {outcome && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-5 rounded-xl border p-4 text-sm leading-6 ${
            outcome.ok ? "border-emerald-700/40 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          <p className="font-semibold">{outcome.ok ? outcome.message : outcome.error}</p>
          {outcome.createdCustomer && <p>A customer record was created from the claim.</p>}
          {outcome.customerId && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/admin/customers/${outcome.customerId}`} className={`${secondaryButton} min-h-9 px-3 text-xs`}>
                Open customer
              </Link>
              {canInvoice && (
                <Link
                  href={`/admin/invoices/new?customerId=${encodeURIComponent(outcome.customerId)}`}
                  className={`${secondaryButton} min-h-9 px-3 text-xs`}
                >
                  New invoice
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Choice({
  value,
  current,
  onChange,
  children,
}: {
  value: string;
  current: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-[#25313F] transition ${
        current === value ? "border-[#0B2A4A] bg-[#F4F6FA]" : "border-[#D5DEE7] bg-white hover:border-[#0B2A4A]/30"
      }`}
    >
      <input
        type="radio"
        name="walk-in-customer"
        className="mt-0.5 h-4 w-4"
        checked={current === value}
        onChange={() => onChange(value)}
      />
      <span>{children}</span>
    </label>
  );
}
