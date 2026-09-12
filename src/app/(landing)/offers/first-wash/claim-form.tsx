"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackMetaLead } from "@/components/meta-pixel";
import { trackGa4Event } from "@/components/google-tag";
import { claimWashOfferAction, type ClaimResult } from "./actions";

export type ClaimFormCopy = {
  carPriceLabel: string;
  largePriceLabel: string;
  claimValidDays: number;
  phone: string;
  privacyNote: string;
};

/** Bright on near-black. Shared so the focus ring is identical on every control. */
const focusRing =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#FFE500]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0B]";
const inputClass = `min-h-14 w-full rounded-xl border-2 border-white/15 bg-white/[0.06] px-4 text-lg text-white placeholder:text-white/35 ${focusRing}`;

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
      className="rounded-3xl border-2 border-[#FFE500]/35 bg-[#141416] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.55)] sm:p-7"
    >
      <p className="text-sm font-black uppercase tracking-[0.16em] text-[#FFE500]">
        Claim your code — takes 20 seconds
      </p>

      <div className="mt-5 space-y-3">
        <div>
          <label htmlFor={`${ids}-first`} className="mb-1.5 block text-sm font-bold text-white">
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
          <label htmlFor={`${ids}-phone`} className="mb-1.5 block text-sm font-bold text-white">
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
          <p id={`${ids}-phone-note`} className="mt-1.5 text-xs text-white/50">
            We text your code here, and one wash per number keeps the offer fair.
          </p>
        </div>

        <div>
          <label htmlFor={`${ids}-email`} className="mb-1.5 block text-sm font-bold text-white">
            Email <span className="font-medium text-white/45">(optional — a backup copy of your code)</span>
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

        <fieldset>
          <legend className="mb-1.5 block text-sm font-bold text-white">What are you driving?</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {(
              [
                ["car", "Car", copy.carPriceLabel, "Coupe or sedan"],
                ["suv", "SUV / Truck", copy.largePriceLabel, "SUV, pickup or van"],
              ] as const
            ).map(([value, title, price, detail]) => (
              <button
                type="button"
                key={value}
                aria-pressed={vehicleSize === value}
                onClick={() => setVehicleSize(value)}
                className={`min-h-20 rounded-xl border-2 px-3 py-3 text-left transition ${focusRing} ${
                  vehicleSize === value
                    ? "border-[#FFE500] bg-[#FFE500]/12"
                    : "border-white/15 bg-white/[0.04] hover:border-white/35"
                }`}
              >
                <span className="block text-base font-bold text-white">{title}</span>
                <span className="block text-xl font-black text-[#FFE500]">{price}</span>
                <span className="mt-0.5 block text-[0.7rem] leading-tight text-white/50">{detail}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {/*
        Unticked, and never a condition of the offer. CASL treats consent to
        marketing as its own decision — tying it to the discount would make the
        consent worthless and the offer worse.
      */}
      <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm leading-6 text-white/70">
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(e) => setMarketingConsent(e.target.checked)}
          className={`mt-1 size-5 shrink-0 accent-[#FFE500] ${focusRing}`}
        />
        <span>
          Send me occasional offers and reminders by text or email. Optional — reply STOP any time.
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border-2 border-red-400/50 bg-red-950/40 p-3 text-sm font-medium text-red-100">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !firstName.trim() || phone.trim().length < 7}
        className={`mt-5 min-h-16 w-full rounded-xl bg-[#FFE500] px-6 text-xl font-black uppercase tracking-wide text-[#0A0A0B] transition hover:bg-[#FFF04D] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        {submitting ? "Getting your code…" : "Get my code"}
      </button>

      {/*
        PIPEDA asks for knowledge and consent at the point of collection: what
        is collected, what it is for, and where the policy is. One sentence,
        under the button, where it is actually read.
      */}
      <p className="mt-3 text-center text-xs leading-5 text-white/45">
        {copy.privacyNote}{" "}
        <Link href="/policies/privacy" className="underline hover:text-white/70">
          Privacy policy
        </Link>
        .
      </p>
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
        className="rounded-3xl border-2 border-white/20 bg-[#141416] p-6 text-center shadow-[0_24px_60px_rgba(0,0,0,0.55)] sm:p-8"
      >
        <h2 className="text-2xl font-black text-white">
          {result.alreadyUsed ? "This code has already been used" : "This code has expired"}
        </h2>
        <p className="mt-3 text-base leading-7 text-white/65">
          {result.alreadyUsed
            ? "Our records show this offer has already been claimed and used on this number. It is one wash per customer — but we would still love to look after your vehicle."
            : `Your code ran out on ${result.expiresLabel}. Give us a call and we will see what we can do for you.`}
        </p>
        <div className="mt-6 grid gap-2.5">
          <a
            href={`tel:${copy.phone}`}
            className={`inline-flex min-h-14 items-center justify-center rounded-xl bg-[#FFE500] px-6 text-lg font-black text-[#0A0A0B] ${focusRing}`}
          >
            Call {copy.phone}
          </a>
          <Link
            href="/services"
            className={`inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-white/25 px-6 text-base font-bold text-white ${focusRing}`}
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
      className="rounded-3xl border-2 border-[#FFE500] bg-[#141416] p-6 text-center shadow-[0_24px_60px_rgba(0,0,0,0.55)] sm:p-8"
    >
      <p className="text-sm font-black uppercase tracking-[0.2em] text-[#FFE500]">
        {result.isNew ? "You're in" : "Here it is again"}
      </p>
      <h2 className="mt-3 text-2xl font-black text-white">Your {result.priceLabel} wash code</h2>

      <p className="mt-5 select-all rounded-2xl border-2 border-dashed border-[#FFE500]/60 bg-[#FFE500]/10 px-4 py-5 font-mono text-3xl font-black tracking-[0.12em] text-[#FFE500] sm:text-4xl">
        {result.code}
      </p>
      <p className="mt-3 text-sm font-bold text-white/80">
        Book by {result.expiresLabel} — {copy.claimValidDays} days from today.
      </p>

      <Link
        href={result.bookingPath}
        className={`mt-6 inline-flex min-h-16 w-full items-center justify-center rounded-xl bg-[#FFE500] px-6 text-xl font-black uppercase tracking-wide text-[#0A0A0B] transition hover:bg-[#FFF04D] ${focusRing}`}
      >
        Pick my time
      </Link>

      <a
        href={`tel:${copy.phone}`}
        className={`mt-2.5 inline-flex min-h-14 w-full items-center justify-center rounded-xl border-2 border-white/25 px-6 text-base font-bold text-white ${focusRing}`}
      >
        Or book by phone: {copy.phone}
      </a>

      <p className="mt-4 text-xs leading-5 text-white/45">
        {result.sentBy.length > 0
          ? `We have also sent it by ${result.sentBy.join(" and ")}. `
          : "Save a screenshot of this code. "}
        Your price is confirmed in the booking, before you agree to anything.
      </p>
    </div>
  );
}
