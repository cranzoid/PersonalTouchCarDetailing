"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackMetaLead } from "@/components/meta-pixel";
import { trackGa4Event } from "@/components/google-tag";
import { claimWashOfferAction, type ClaimResult } from "./actions";

export type ClaimFormCopy = {
  priceLabel: string;
  priceValue: number;
  currency: string;
  claimValidDays: number;
  phone: string;
  businessName: string;
  email: string;
  address: string;
  offerTerms: string[];
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#4DE3F2]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-white";
const inputClass = `min-h-13 w-full rounded-xl border-2 border-[#D8E0E2] bg-[#F9FBFB] px-4 text-base text-[#071419] placeholder:text-[#758286] transition hover:border-[#A9B8BC] focus:border-[#071419] ${focusRing}`;

export function ClaimForm({ copy }: { copy: ClaimFormCopy }) {
  const ids = useId();
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehicleSize, setVehicleSize] = useState<"car" | "suv">("car");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ClaimResult | null>(null);

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit =
    firstName.trim().length > 0 && phone.trim().length >= 7 && emailLooksValid && termsAccepted;
  const error = result && !result.ok ? result.error : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    const res = await claimWashOfferAction({
      firstName,
      phone,
      email,
      vehicleSize,
      termsAccepted,
      attribution: getStoredAttribution(),
    });
    setSubmitting(false);
    setResult(res);

    // A Lead means the server actually created a new claim—not a click, a
    // validation error, or somebody asking for the same code again.
    if (res.ok && res.isNew) {
      trackMetaLead({
        content_name: "First Detail Offer",
        content_category: "offer_claim",
        value: copy.priceValue,
        currency: copy.currency,
      });
      trackGa4Event("offer_claimed", {
        offer: "first_detail",
        vehicle_size: vehicleSize,
        value: copy.priceValue,
        currency: copy.currency,
      });
    }
  }

  if (result?.ok) return <ClaimSuccess result={result} copy={copy} />;

  return (
    <form
      id="claim"
      onSubmit={submit}
      noValidate
      className="overflow-hidden rounded-[1.75rem] bg-white text-[#071419] shadow-[0_28px_80px_-24px_rgba(0,0,0,0.65)] ring-1 ring-black/10"
    >
      <div className="flex items-center justify-between gap-4 bg-[#071419] px-5 py-4 sm:px-7">
        <div>
          <p className="text-[0.68rem] font-black uppercase tracking-[0.2em] text-[#4DE3F2]">
            Claim in under a minute
          </p>
          <p className="mt-1 text-xl font-black text-white">Get your wash code</p>
        </div>
        <span className="rounded-full bg-[#DFFF45] px-3 py-1.5 text-sm font-black text-[#071419]">
          {copy.priceLabel}
        </span>
      </div>

      <div className="space-y-4 px-5 pb-6 pt-5 sm:px-7 sm:pb-7">
        <div>
          <label htmlFor={`${ids}-first`} className="mb-1.5 block text-sm font-bold">
            First name
          </label>
          <input
            id={`${ids}-first`}
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            autoComplete="given-name"
            required
            maxLength={60}
            placeholder="Sam"
            className={inputClass}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <div>
            <label htmlFor={`${ids}-phone`} className="mb-1.5 block text-sm font-bold">
              Mobile number
            </label>
            <input
              id={`${ids}-phone`}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              maxLength={30}
              placeholder="(905) 555-0123"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={`${ids}-email`} className="mb-1.5 block text-sm font-bold">
              Email
            </label>
            <input
              id={`${ids}-email`}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={200}
              placeholder="sam@example.com"
              className={inputClass}
            />
          </div>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-bold">Your vehicle</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {(
              [
                ["car", "Car", "Coupe or sedan"],
                ["suv", "SUV / Truck", "SUV, pickup or van"],
              ] as const
            ).map(([value, title, detail]) => (
              <button
                type="button"
                key={value}
                aria-pressed={vehicleSize === value}
                onClick={() => setVehicleSize(value)}
                className={`min-h-16 rounded-xl border-2 px-3.5 py-2.5 text-left transition ${focusRing} ${
                  vehicleSize === value
                    ? "border-[#071419] bg-[#071419] text-white"
                    : "border-[#D8E0E2] bg-[#F9FBFB] hover:border-[#93A5AA]"
                }`}
              >
                <span className="block text-sm font-black sm:text-base">{title}</span>
                <span className={`block text-[0.68rem] ${vehicleSize === value ? "text-[#B9C9CD]" : "text-[#657579]"}`}>
                  {detail}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs font-medium text-[#59686C]">
            Same {copy.priceLabel} price either way.
          </p>
        </fieldset>

        <div className="rounded-xl border border-[#C9D4D6] bg-[#F3F7F7] p-3.5">
          <div className="flex items-start gap-3">
            <input
              id={`${ids}-terms`}
              type="checkbox"
              required
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              className={`mt-0.5 size-5 shrink-0 accent-[#071419] ${focusRing}`}
            />
            <div className="text-sm leading-5">
              <label htmlFor={`${ids}-terms`} className="cursor-pointer font-bold">
                I agree to the Terms &amp; Conditions.
              </label>{" "}
              <button
                type="button"
                aria-expanded={showTerms}
                aria-controls={`${ids}-terms-panel`}
                onClick={() => setShowTerms((open) => !open)}
                className="font-bold text-[#087B87] underline decoration-2 underline-offset-2"
              >
                {showTerms ? "Hide terms" : "Read terms"}
              </button>
            </div>
          </div>

          {showTerms && (
            <div id={`${ids}-terms-panel`} className="mt-4 max-h-72 overflow-y-auto border-t border-[#C9D4D6] pt-4 text-xs leading-5 text-[#445459]">
              <p className="font-black uppercase tracking-[0.12em] text-[#071419]">Service terms</p>
              <p className="mt-1">
                Appointments are subject to availability. Pricing and included work are confirmed before booking.
                Any additional work or charge requires your approval. Remove valuables before service; pre-existing
                damage and defects revealed by cleaning are not caused by the wash. Payment is due at pickup unless
                otherwise arranged. Our{" "}
                <Link href="/policies/terms" target="_blank" className="font-bold underline">full service terms</Link>,{" "}
                <Link href="/policies/cancellation" target="_blank" className="font-bold underline">cancellation policy</Link>{" "}
                and <Link href="/policies/privacy" target="_blank" className="font-bold underline">privacy policy</Link> apply.
              </p>

              <p className="mt-4 font-black uppercase tracking-[0.12em] text-[#071419]">First wash offer</p>
              <ul className="mt-1 space-y-1.5">
                {copy.offerTerms.map((term) => <li key={term}>• {term}</li>)}
              </ul>

              <p className="mt-4 font-black uppercase tracking-[0.12em] text-[#071419]">Electronic messages</p>
              <p className="mt-1">
                By checking this box and submitting, you expressly agree to receive the requested code, booking
                reminders and occasional promotional texts and emails from {copy.businessName} at the mobile number
                and email you provide. Message frequency varies; message and data rates may apply. Reply STOP to a
                text or use the unsubscribe link in an email at any time. Consent can be withdrawn without affecting
                a booked service. Contact: {copy.address}, {copy.phone}, {copy.email}.
              </p>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className={`min-h-15 w-full rounded-xl bg-[#DFFF45] px-6 text-lg font-black text-[#071419] shadow-[0_12px_28px_-10px_rgba(166,205,34,0.75)] transition hover:-translate-y-0.5 hover:bg-[#EAFF88] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${focusRing}`}
        >
          {submitting ? "Getting your code…" : `Get my ${copy.priceLabel} code →`}
        </button>

        <p className="text-center text-xs leading-5 text-[#59686C]">
          Your code is shown instantly and sent by both text and email.
        </p>
      </div>
    </form>
  );
}

function ClaimSuccess({ result, copy }: { result: Extract<ClaimResult, { ok: true }>; copy: ClaimFormCopy }) {
  if (result.alreadyUsed || result.expired) {
    return (
      <div role="status" className="rounded-[1.75rem] bg-white p-6 text-center text-[#071419] shadow-2xl sm:p-8">
        <h2 className="text-3xl font-black leading-tight">
          {result.alreadyUsed ? "This code has already been used" : "This code has expired"}
        </h2>
        <p className="mt-3 text-base leading-7 text-[#526267]">
          {result.alreadyUsed
            ? "This offer has already been used on this number. You can still book at our regular price."
            : `Your code expired on ${result.expiresLabel}. Call us and we will see what we can do.`}
        </p>
        <a href={`tel:${copy.phone}`} className="mt-6 inline-flex min-h-14 w-full items-center justify-center rounded-xl bg-[#DFFF45] px-6 text-lg font-black">
          Call {copy.phone}
        </a>
      </div>
    );
  }

  const delivered = result.sentBy.length === 2
    ? "We sent a copy by text and email."
    : result.sentBy.length === 1
      ? `We sent a copy by ${result.sentBy[0]}.`
      : "Save a screenshot of this code.";

  return (
    <div role="status" aria-live="polite" className="overflow-hidden rounded-[1.75rem] bg-white text-center text-[#071419] shadow-2xl">
      <div className="bg-[#071419] px-6 py-4 text-xs font-black uppercase tracking-[0.2em] text-[#4DE3F2]">
        {result.isNew ? "Your offer is ready" : "Here is your code again"}
      </div>
      <div className="px-6 pb-7 pt-6 sm:px-8">
        <h2 className="text-3xl font-black leading-tight">Your {result.priceLabel} wash code</h2>
        <p className="mt-5 select-all rounded-2xl border-2 border-dashed border-[#087B87] bg-[#EEFBFC] px-4 py-5 font-mono text-3xl font-black tracking-[0.1em] sm:text-4xl">
          {result.code}
        </p>
        <p className="mt-3 text-sm font-bold text-[#526267]">Book by {result.expiresLabel}.</p>
        <Link href={result.bookingPath} className="mt-6 inline-flex min-h-16 w-full items-center justify-center rounded-xl bg-[#DFFF45] px-6 text-xl font-black shadow-lg transition hover:-translate-y-0.5 hover:bg-[#EAFF88]">
          Pick my time →
        </Link>
        <a href={`tel:${copy.phone}`} className="mt-2.5 inline-flex min-h-13 w-full items-center justify-center rounded-xl border-2 border-[#C9D4D6] px-5 text-sm font-bold hover:border-[#071419]">
          Or call {copy.phone}
        </a>
        <p className="mt-4 text-xs leading-5 text-[#59686C]">{delivered} Your price appears before you confirm the booking.</p>
      </div>
    </div>
  );
}
