"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackMetaLead } from "@/components/meta-pixel";
import { trackGa4Event } from "@/components/google-tag";
import { claimWashOfferAction, type ClaimResult } from "./actions";

export type ClaimFormCopy = {
  /** The one offer price, e.g. "$15.99". The same for every vehicle size. */
  priceLabel: string;
  claimValidDays: number;
  phone: string;
  privacyNote: string;
};

/**
 * The card is warm ivory on the navy page — the same light-on-dark pairing the
 * main site uses for its own content surfaces. A form is the one thing here
 * that people have to read and type into, and it should look like paper.
 */
const focusRing =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#F6F2EA]";
const inputClass = `min-h-14 w-full rounded-xl border border-ink-300 bg-white px-4 text-lg text-ink-950 placeholder:text-ink-400 ${focusRing}`;

export function ClaimForm({ copy }: { copy: ClaimFormCopy }) {
  const ids = useId();
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehicleSize, setVehicleSize] = useState<"car" | "suv">("car");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ClaimResult | null>(null);

  const error = result && !result.ok ? result.error : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const res = await claimWashOfferAction({
      firstName,
      phone,
      email: email || undefined,
      vehicleSize,
      marketingConsent,
      attribution: getStoredAttribution(),
    });
    setSubmitting(false);
    setResult(res);
    // Only a genuinely new claim is a lead. Re-issuing a code to someone who
    // already holds one must not be counted twice, or the ad spend is being
    // judged against a number that includes the same person repeatedly.
    if (res.ok && res.isNew) {
      trackMetaLead({ content_name: "First Wash Offer", content_category: "offer_claim" });
      trackGa4Event("offer_claimed", { offer: "first_wash", vehicle_size: vehicleSize });
    }
  }

  if (result?.ok) {
    return <ClaimSuccess result={result} copy={copy} />;
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="overflow-hidden rounded-3xl bg-[#F6F2EA] shadow-[0_30px_70px_-24px_rgba(0,0,0,0.75)] ring-1 ring-ink-950/10"
    >
      <div className="bg-ink-900 px-5 py-4 sm:px-7">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">
          Claim your code — takes 20 seconds
        </p>
        <p className="mt-1.5 font-display text-2xl leading-tight text-white">
          {copy.priceLabel} wash, any vehicle
        </p>
      </div>

      <div className="px-5 pb-6 pt-5 sm:px-7 sm:pb-7">
        <div className="space-y-3">
          <div>
            <label htmlFor={`${ids}-first`} className="mb-1.5 block text-sm font-semibold text-ink-950">
              First name
            </label>
            <input
              id={`${ids}-first`}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              required
              maxLength={60}
              placeholder="Sam"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={`${ids}-phone`} className="mb-1.5 block text-sm font-semibold text-ink-950">
              Mobile number
            </label>
            <input
              id={`${ids}-phone`}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              maxLength={30}
              placeholder="(905) 555-0123"
              aria-describedby={`${ids}-phone-note`}
              className={inputClass}
            />
            <p id={`${ids}-phone-note`} className="mt-1.5 text-xs text-ink-500">
              We text your code here, and one wash per number keeps the offer fair.
            </p>
          </div>

          <div>
            <label htmlFor={`${ids}-email`} className="mb-1.5 block text-sm font-semibold text-ink-950">
              Email <span className="font-normal text-ink-500">(optional — a backup copy of your code)</span>
            </label>
            <input
              id={`${ids}-email`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={200}
              placeholder="sam@example.com"
              className={inputClass}
            />
          </div>

          {/*
            Asked even though it no longer changes the price. It decides how
            long the bay is held, tells the shop what is actually coming through
            the door, and is on the claim before anyone books — which is the
            only reason it is worth two taps. Said plainly, so nobody picks
            "car" for a pickup hoping to save money that is not on offer.
          */}
          <fieldset>
            <legend className="mb-1.5 block text-sm font-semibold text-ink-950">
              What are you driving?
            </legend>
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
                  className={`min-h-16 rounded-xl border px-3.5 py-3 text-left transition ${focusRing} ${
                    vehicleSize === value
                      ? "border-ink-900 bg-ink-900 text-white shadow-sm"
                      : "border-ink-300 bg-white text-ink-950 hover:border-ink-500"
                  }`}
                >
                  <span className="block text-base font-semibold">{title}</span>
                  <span
                    className={`mt-0.5 block text-xs leading-tight ${
                      vehicleSize === value ? "text-ink-200" : "text-ink-500"
                    }`}
                  >
                    {detail}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-500">
              {copy.priceLabel} either way — it just tells us how much time to set aside.
            </p>
          </fieldset>
        </div>

        {/*
          Unticked, and never a condition of the offer. CASL treats consent to
          marketing as its own decision — tying it to the discount would make the
          consent worthless and the offer worse.
        */}
        <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm leading-6 text-ink-700">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => setMarketingConsent(e.target.checked)}
            className={`mt-1 size-5 shrink-0 accent-[#0B2A4A] ${focusRing}`}
          />
          <span>
            Send me occasional offers and reminders by text or email. Optional — reply STOP any time.
          </span>
        </label>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !firstName.trim() || phone.trim().length < 7}
          className={`mt-5 min-h-16 w-full rounded-xl bg-accent-400 px-6 text-xl font-bold text-ink-950 shadow-[0_12px_30px_-8px_rgba(166,111,18,0.55)] transition hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${focusRing}`}
        >
          {submitting ? "Getting your code…" : `Get my ${copy.priceLabel} code`}
        </button>

        {/*
          PIPEDA asks for knowledge and consent at the point of collection: what
          is collected, what it is for, and where the policy is. One sentence,
          under the button, where it is actually read.
        */}
        <p className="mt-3 text-center text-xs leading-5 text-ink-500">
          {copy.privacyNote}{" "}
          <Link href="/policies/privacy" className="underline hover:text-ink-900">
            Privacy policy
          </Link>
          .
        </p>
      </div>
    </form>
  );
}

function ClaimSuccess({ result, copy }: { result: Extract<ClaimResult, { ok: true }>; copy: ClaimFormCopy }) {
  // A code that is already spent or out of date must not be shown under a
  // "you're in" heading — that is a promise the counter would have to break.
  if (result.alreadyUsed || result.expired) {
    return (
      <div
        role="status"
        className="rounded-3xl bg-[#F6F2EA] p-6 text-center shadow-[0_30px_70px_-24px_rgba(0,0,0,0.75)] ring-1 ring-ink-950/10 sm:p-8"
      >
        <h2 className="font-display text-3xl leading-tight text-ink-950">
          {result.alreadyUsed ? "This code has already been used" : "This code has expired"}
        </h2>
        <p className="mt-3 text-base leading-7 text-ink-700">
          {result.alreadyUsed
            ? "Our records show this offer has already been claimed and used on this number. It is one wash per customer — but we would still love to look after your vehicle."
            : `Your code ran out on ${result.expiresLabel}. Give us a call and we will see what we can do for you.`}
        </p>
        <div className="mt-6 grid gap-2.5">
          <a
            href={`tel:${copy.phone}`}
            className={`inline-flex min-h-14 items-center justify-center rounded-xl bg-accent-400 px-6 text-lg font-bold text-ink-950 transition hover:bg-accent-300 ${focusRing}`}
          >
            Call {copy.phone}
          </a>
          <Link
            href="/services"
            className={`inline-flex min-h-14 items-center justify-center rounded-xl border border-ink-400 px-6 text-base font-semibold text-ink-950 transition hover:border-ink-900 ${focusRing}`}
          >
            See all our services
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="overflow-hidden rounded-3xl bg-[#F6F2EA] text-center shadow-[0_30px_70px_-24px_rgba(0,0,0,0.75)] ring-1 ring-ink-950/10"
    >
      <div className="bg-ink-900 px-6 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">
          {result.isNew ? "You're in" : "Here it is again"}
        </p>
      </div>

      <div className="px-6 pb-7 pt-6 sm:px-8">
        <h2 className="font-display text-3xl leading-tight text-ink-950">
          Your {result.priceLabel} wash code
        </h2>

        <p className="mt-5 select-all rounded-2xl border-2 border-dashed border-accent-500/70 bg-white px-4 py-5 font-mono text-3xl font-bold tracking-[0.12em] text-ink-950 sm:text-4xl">
          {result.code}
        </p>
        <p className="mt-3 text-sm font-semibold text-ink-700">
          Book by {result.expiresLabel} — {copy.claimValidDays} days from today.
        </p>

        <Link
          href={result.bookingPath}
          className={`mt-6 inline-flex min-h-16 w-full items-center justify-center rounded-xl bg-accent-400 px-6 text-xl font-bold text-ink-950 shadow-[0_12px_30px_-8px_rgba(166,111,18,0.55)] transition hover:bg-accent-300 ${focusRing}`}
        >
          Pick my time
        </Link>

        <a
          href={`tel:${copy.phone}`}
          className={`mt-2.5 inline-flex min-h-14 w-full items-center justify-center rounded-xl border border-ink-400 px-6 text-base font-semibold text-ink-950 transition hover:border-ink-900 ${focusRing}`}
        >
          Or book by phone: {copy.phone}
        </a>

        <p className="mt-4 text-xs leading-5 text-ink-500">
          {result.sentBy.length > 0
            ? `We have also sent it by ${result.sentBy.join(" and ")}. `
            : "Save a screenshot of this code. "}
          Your price is confirmed in the booking, before you agree to anything.
        </p>
      </div>
    </div>
  );
}
