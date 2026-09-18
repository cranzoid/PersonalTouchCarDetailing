"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackMetaEvent, trackMetaLead } from "@/components/meta-pixel";
import { trackBookAppointmentConversion, trackGa4Event } from "@/components/google-tag";
import { localDateISO } from "@/lib/tz";
import type { WashOfferFlow } from "@/lib/wash-offer";
import {
  bookWashOfferAction,
  claimWashOfferAction,
  washOfferSlotsAction,
  type ClaimResult,
  type WashBookingResult,
} from "./actions";

export type ClaimFormCopy = {
  /**
   * Which arm of the A/B test this page is running. It changes the button, the
   * promise under it and what happens after the details are submitted — never
   * the offer itself, which is the same wash at the same price either way.
   */
  flow: WashOfferFlow;
  priceLabel: string;
  /** The same wash paid for by card or cheque. See DECISIONS.md #18. */
  priceWithTaxLabel: string;
  priceValue: number;
  currency: string;
  claimValidDays: number;
  phone: string;
  businessName: string;
  email: string;
  address: string;
  taxLabel: string;
  /** Business timezone, so "tomorrow" is the shop's tomorrow and not the browser's. */
  timezone: string;
  maxBookingWindowDays: number;
  offerTerms: string[];
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#4DE3F2]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-white";
const inputClass = `min-h-13 w-full rounded-xl border-2 border-[#D8E0E2] bg-[#F9FBFB] px-4 text-base text-[#071419] placeholder:text-[#758286] transition hover:border-[#A9B8BC] focus:border-[#071419] ${focusRing}`;
const primaryButton = `min-h-15 w-full rounded-xl bg-[#DFFF45] px-6 text-lg font-black text-[#071419] shadow-[0_12px_28px_-10px_rgba(166,205,34,0.75)] transition hover:-translate-y-0.5 hover:bg-[#EAFF88] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${focusRing}`;

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
  // The book-first arm asks for a time before it hands anything over, so the
  // button must not promise a code on this screen.
  const bookFirst = copy.flow === "book_first";

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
    // validation error, or somebody asking for the same code again. It fires in
    // both arms and at the same point, so the two are comparable.
    if (res.ok && res.isNew) {
      trackMetaLead({
        content_name: "First Detail Offer",
        content_category: "offer_claim",
        value: copy.priceValue,
        currency: copy.currency,
      });
      trackGa4Event("offer_claimed", {
        offer: "first_detail",
        flow: res.flow,
        vehicle_size: vehicleSize,
        value: copy.priceValue,
        currency: copy.currency,
      });
    }
  }

  if (result?.ok) {
    if (result.alreadyUsed || result.expired) {
      return <ClaimUnavailable result={result} copy={copy} />;
    }
    // Book-first: the claim exists but nothing has been sent. The time picker
    // takes over this card — same page, same theme, no second form to fill in.
    if (result.flow === "book_first") {
      return <TimeStep claim={result} copy={copy} vehicleSize={vehicleSize} />;
    }
    return <ClaimSuccess result={result} copy={copy} />;
  }

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
            {bookFirst ? "Step 1 of 2" : "Claim in under a minute"}
          </p>
          <p className="mt-1 text-xl font-black text-white">
            {bookFirst ? "Book your wash" : "Get your wash code"}
          </p>
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

        <button type="submit" disabled={submitting || !canSubmit} className={primaryButton}>
          {submitting
            ? bookFirst
              ? "Loading times…"
              : "Getting your code…"
            : bookFirst
              ? "Choose my time →"
              : `Get my ${copy.priceLabel} code →`}
        </button>

        <p className="text-center text-xs leading-5 text-[#59686C]">
          {bookFirst
            ? `Next: pick a day and time. Nothing to pay now — you pay ${copy.priceLabel} at the shop.`
            : "Your code is shown instantly and sent by both text and email."}
        </p>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 (book-first): the day and the time, on the same page         */
/* ------------------------------------------------------------------ */

type LiveClaim = Extract<ClaimResult, { ok: true }>;

function TimeStep({
  claim,
  copy,
  vehicleSize,
}: {
  claim: LiveClaim;
  copy: ClaimFormCopy;
  vehicleSize: "car" | "suv";
}) {
  const ids = useId();
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<{ startMs: number; label: string }[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState<Extract<WashBookingResult, { ok: true }> | null>(null);

  // Business-local calendar dates. toISOString() gives the UTC day, which after
  // ~8pm in America/Toronto has already rolled over and would push the earliest
  // bookable day a full day further out than the notice rule requires.
  const minDate = localDateISO(copy.timezone, 86_400_000);
  const maxDate = localDateISO(copy.timezone, copy.maxBookingWindowDays * 86_400_000);

  async function loadSlots(date: string) {
    setDateISO(date);
    setStartMs(null);
    setError(null);
    if (!date) {
      setSlots(null);
      return;
    }
    setSlotsLoading(true);
    setSlots(null);
    const res = await washOfferSlotsAction({ code: claim.code, dateISO: date });
    setSlotsLoading(false);
    if (res.ok) {
      setSlots(res.slots);
      trackGa4Event("offer_availability_result", {
        offer: "first_detail",
        status: res.slots.length > 0 ? "available" : "no_slots",
      });
    } else {
      setSlots([]);
      setError(res.error);
    }
  }

  async function confirm() {
    if (booking || !dateISO || startMs === null) return;
    setBooking(true);
    setError(null);
    const res = await bookWashOfferAction({ code: claim.code, dateISO, startMs });
    setBooking(false);
    if (res.ok) {
      setBooked(res);
      // The claim already reported a Lead. This is the appointment behind it,
      // so it is a Schedule — one person must not become two Meta leads.
      trackMetaEvent("Schedule", {
        content_name: "First Wash Appointment",
        content_category: "offer_booking",
        value: copy.priceValue,
        currency: copy.currency,
      });
      trackBookAppointmentConversion();
      trackGa4Event("offer_booked", {
        offer: "first_detail",
        vehicle_size: vehicleSize,
        value: copy.priceValue,
        currency: copy.currency,
      });
      return;
    }
    setError(res.error);
    // Somebody took the slot while this was open, or the day filled up. Send
    // them back to the grid rather than leaving a dead button on screen.
    if (res.retry) {
      setStartMs(null);
      if (dateISO) void loadSlots(dateISO);
    }
  }

  if (booked) return <BookedPanel booked={booked} copy={copy} />;

  return (
    <div id="claim" className="overflow-hidden rounded-[1.75rem] bg-white text-[#071419] shadow-[0_28px_80px_-24px_rgba(0,0,0,0.65)] ring-1 ring-black/10">
      <div className="flex items-center justify-between gap-4 bg-[#071419] px-5 py-4 sm:px-7">
        <div>
          <p className="text-[0.68rem] font-black uppercase tracking-[0.2em] text-[#4DE3F2]">Step 2 of 2</p>
          <p className="mt-1 text-xl font-black text-white">Pick your time</p>
        </div>
        <span className="rounded-full bg-[#DFFF45] px-3 py-1.5 text-sm font-black text-[#071419]">
          {copy.priceLabel}
        </span>
      </div>

      <div className="space-y-4 px-5 pb-6 pt-5 sm:px-7 sm:pb-7">
        <p className="text-sm leading-6 text-[#526267]">
          Exterior hand wash for your {vehicleSize === "suv" ? "SUV, pickup or van" : "car"}. Choose a day
          and we will show you what is free.
        </p>

        <div>
          <label htmlFor={`${ids}-date`} className="mb-1.5 block text-sm font-bold">
            Choose a day
          </label>
          <input
            id={`${ids}-date`}
            type="date"
            min={minDate}
            max={maxDate}
            value={dateISO}
            onChange={(event) => void loadSlots(event.target.value)}
            className={inputClass}
          />
        </div>

        <div aria-live="polite" aria-atomic="true" className="min-h-6">
          {slotsLoading && <p className="text-sm font-bold text-[#526267]">Checking what is free…</p>}
          {!slotsLoading && slots && slots.length === 0 && !error && (
            <p className="rounded-xl border border-[#C9D4D6] bg-[#F3F7F7] p-3 text-sm font-bold text-[#445459]">
              Nothing free that day. Please try another — or call {copy.phone} and we will fit you in.
            </p>
          )}
          {!slotsLoading && slots && slots.length > 0 && (
            <div role="group" aria-label="Available times" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((slot) => (
                <button
                  type="button"
                  key={slot.startMs}
                  aria-pressed={startMs === slot.startMs}
                  onClick={() => setStartMs(slot.startMs)}
                  className={`min-h-12 rounded-xl border-2 px-2 text-sm font-black transition ${focusRing} ${
                    startMs === slot.startMs
                      ? "border-[#071419] bg-[#071419] text-white"
                      : "border-[#D8E0E2] bg-[#F9FBFB] hover:border-[#93A5AA]"
                  }`}
                >
                  {slot.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border-2 border-dashed border-[#087B87] bg-[#EEFBFC] p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-black uppercase tracking-[0.12em] text-[#087B87]">You pay</span>
            <span className="text-3xl font-black">{copy.priceLabel}</span>
          </div>
          {/* One price, tax on top. What the customer pays with is settled at
              the counter and is the shop's own affair (DECISIONS.md #18) — it
              is not a cheaper price to advertise here. */}
          <p className="mt-2 text-xs leading-5 text-[#445459]">
            Plus {copy.taxLabel} — {copy.priceWithTaxLabel} in total. Nothing to pay now; you pay at
            the shop when the wash is done.
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
            {error}
          </p>
        )}

        <button type="button" onClick={() => void confirm()} disabled={booking || startMs === null} className={primaryButton}>
          {booking ? "Booking your wash…" : `Confirm my ${copy.priceLabel} wash →`}
        </button>

        <p className="text-center text-xs leading-5 text-[#59686C]">
          Your code appears here as soon as it is booked, and we text and email it to you.
        </p>
      </div>
    </div>
  );
}

function BookedPanel({
  booked,
  copy,
}: {
  booked: Extract<WashBookingResult, { ok: true }>;
  copy: ClaimFormCopy;
}) {
  const delivered =
    booked.sentBy.length === 2
      ? "We sent the details by text and email."
      : booked.sentBy.length === 1
        ? `We sent the details by ${booked.sentBy[0] === "sms" ? "text" : "email"}.`
        : "Save a screenshot of this code.";

  return (
    <div role="status" aria-live="polite" className="overflow-hidden rounded-[1.75rem] bg-white text-center text-[#071419] shadow-2xl">
      <div className="bg-[#071419] px-6 py-4 text-xs font-black uppercase tracking-[0.2em] text-[#4DE3F2]">
        You are booked in
      </div>
      <div className="px-6 pb-7 pt-6 sm:px-8">
        <h2 className="text-3xl font-black leading-tight">{booked.whenLabel}</h2>
        <p className="mt-3 text-sm font-bold text-[#526267]">
          {booked.priceLabel} plus {copy.taxLabel} — {booked.priceWithTaxLabel} in total
        </p>
        <p className="mt-5 text-xs font-black uppercase tracking-[0.14em] text-[#087B87]">Show this on arrival</p>
        <p className="mt-2 select-all rounded-2xl border-2 border-dashed border-[#087B87] bg-[#EEFBFC] px-4 py-5 font-mono text-3xl font-black tracking-[0.1em] sm:text-4xl">
          {booked.code}
        </p>
        <p className="mt-4 text-sm leading-6 text-[#526267]">
          {delivered} Need to change the time? Call or text {copy.phone} and we will move it.
        </p>
        <a href={`tel:${copy.phone}`} className="mt-5 inline-flex min-h-13 w-full items-center justify-center rounded-xl border-2 border-[#C9D4D6] px-5 text-sm font-bold hover:border-[#071419]">
          Call {copy.phone}
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared outcomes                                                     */
/* ------------------------------------------------------------------ */

function ClaimUnavailable({ result, copy }: { result: LiveClaim; copy: ClaimFormCopy }) {
  // They already booked and have come back — almost always to find the code
  // again. Give them it, rather than the refusal meant for somebody who has
  // had their wash.
  if (result.bookedWhenLabel) {
    return (
      <div role="status" className="overflow-hidden rounded-[1.75rem] bg-white text-center text-[#071419] shadow-2xl">
        <div className="bg-[#071419] px-6 py-4 text-xs font-black uppercase tracking-[0.2em] text-[#4DE3F2]">
          You are already booked in
        </div>
        <div className="px-6 pb-7 pt-6 sm:px-8">
          <h2 className="text-3xl font-black leading-tight">{result.bookedWhenLabel}</h2>
          <p className="mt-5 text-xs font-black uppercase tracking-[0.14em] text-[#087B87]">Show this on arrival</p>
          <p className="mt-2 select-all rounded-2xl border-2 border-dashed border-[#087B87] bg-[#EEFBFC] px-4 py-5 font-mono text-3xl font-black tracking-[0.1em] sm:text-4xl">
            {result.code}
          </p>
          <p className="mt-4 text-sm leading-6 text-[#526267]">
            Need a different time, or can&rsquo;t make it? Call or text {copy.phone} and we will move it.
          </p>
          <a href={`tel:${copy.phone}`} className="mt-5 inline-flex min-h-13 w-full items-center justify-center rounded-xl border-2 border-[#C9D4D6] px-5 text-sm font-bold hover:border-[#071419]">
            Call {copy.phone}
          </a>
        </div>
      </div>
    );
  }

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

function ClaimSuccess({ result, copy }: { result: LiveClaim; copy: ClaimFormCopy }) {
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
