"use client";

import { useEffect, useId, useRef, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackGa4Event, trackRequestQuoteConversion } from "@/components/google-tag";
import { trackMetaLead } from "@/components/meta-pixel";
import { FESTIVE_COATING_ENQUIRY_TYPE, FESTIVE_COATING_OFFER_PATH } from "@/lib/festive-coating-offer";
import { submitQuoteAction, type QuoteResult } from "../../../(public)/quote/actions";

const inputClass =
  "min-h-12 w-full rounded-xl border border-[#E4D3AE] bg-white px-3.5 py-3 text-base text-[#14112B] placeholder:text-slate-400 focus:border-[#B7791F] focus:outline-none focus:ring-2 focus:ring-[#F2B83B]/50 disabled:opacity-60";
const eventContext = { offer: FESTIVE_COATING_ENQUIRY_TYPE, page_path: FESTIVE_COATING_OFFER_PATH };

/**
 * Callback request for the festive QR offer. It goes through the public quote
 * action, so it lands in Leads → Quote requests beside every other request,
 * with the usual acknowledgement email and follow-up date. The Crystal service
 * id is attached so the request names the package it is about.
 */
export function FestiveRequestForm({ serviceId, offerLabel, phone }: {
  serviceId: string | null;
  offerLabel: string;
  phone: string;
}) {
  const id = useId();
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const submitting = useRef(false);
  const viewed = useRef(false);

  useEffect(() => {
    // afterInteractive tag initialization can follow this component's mount.
    let attempts = 0;
    function recordView() {
      if (!viewed.current && typeof window.gtag === "function") {
        viewed.current = true;
        trackGa4Event("festive_coating_view", eventContext);
      }
      return viewed.current || ++attempts >= 40;
    }
    if (recordView()) return;
    const timer = window.setInterval(() => {
      if (recordView()) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  function start() {
    if (started.current) return;
    started.current = true;
    trackGa4Event("festive_coating_start", eventContext);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setResult(null);
    const fields = new FormData(event.currentTarget);
    const payload = new FormData();
    payload.set("payload", JSON.stringify({
      name: fields.get("name"),
      email: fields.get("email"),
      phone: fields.get("phone"),
      serviceIds: serviceId ? [serviceId] : [],
      conditionDescription:
        `Navratri & Diwali QR offer: Crystal ceramic coating for ${offerLabel} on a new vehicle. ` +
        "Please call back to confirm the vehicle and arrange a day.",
      marketingConsent: false,
      attribution: { ...getStoredAttribution(), enquiryPage: FESTIVE_COATING_OFFER_PATH, enquiryType: FESTIVE_COATING_ENQUIRY_TYPE },
    }));
    try {
      const response = await submitQuoteAction(payload);
      setResult(response);
      if (response.ok) {
        // A lead is counted only after the server action has persisted it.
        trackMetaLead({ content_name: "Festive Ceramic Coating Offer", content_category: "callback_request" });
        trackRequestQuoteConversion();
        trackGa4Event("festive_coating_success", eventContext);
      } else {
        trackGa4Event("festive_coating_error", { ...eventContext, error_type: "server_rejected" });
      }
    } catch {
      setResult({ ok: false, error: "We couldn’t send your request. Please try again or call us." });
      trackGa4Event("festive_coating_error", { ...eventContext, error_type: "network" });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div id="request" className="scroll-mt-6 rounded-[1.75rem] border border-[#F2B83B]/50 bg-[#FFFBF2] p-5 text-[#14112B] shadow-[0_30px_90px_-30px_rgba(242,184,59,0.45)] sm:p-7">
      {result?.ok ? (
        <div role="status" aria-live="polite" className="py-4">
          <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-full bg-gradient-to-br from-[#FFD36B] to-[#F08A24] text-2xl font-black text-[#14112B]">✓</span>
          <h2 className="mt-5 text-2xl font-black tracking-tight">Request received!</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            Thank you! We’ll call you within one business day to confirm your vehicle and pick a day for your coating at {offerLabel}. Nothing has been charged.
          </p>
          <p className="mt-4 break-all text-xs text-slate-500">Reference: {result.reference}</p>
          <a href={`tel:${phone}`} className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-[#14112B] px-4 font-bold text-white transition hover:bg-[#2A2350]">
            Can’t wait? Call {phone}
          </a>
        </div>
      ) : (
        <>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-[#B45309]">Claim the festive price</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight sm:text-[1.7rem]">Get a call back</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Leave your details and we’ll ring you to confirm your vehicle and book a day.</p>
          <form onSubmit={submit} onFocusCapture={start} aria-busy={busy} className="mt-5 space-y-4">
            <label htmlFor={`${id}-name`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Your name</span>
              <input id={`${id}-name`} name="name" autoComplete="name" required maxLength={150} disabled={busy} className={inputClass} />
            </label>
            <label htmlFor={`${id}-phone`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Phone number</span>
              <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required minLength={7} maxLength={30} disabled={busy} className={inputClass} />
            </label>
            <label htmlFor={`${id}-email`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Email</span>
              <input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={200} disabled={busy} className={inputClass} />
            </label>
            {result && !result.ok && (
              <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
                {result.error} <a href={`tel:${phone}`} className="font-bold underline">Call {phone}</a>
              </p>
            )}
            <button type="submit" disabled={busy} className="min-h-14 w-full rounded-xl bg-gradient-to-r from-[#FFC94D] via-[#F7A928] to-[#F08A24] px-4 py-3 text-lg font-black text-[#14112B] shadow-lg shadow-[#F08A24]/25 transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60">
              {busy ? "Sending…" : "Request my call back →"}
            </button>
            <p className="text-center text-xs leading-5 text-slate-500">
              No payment now. We use your details only to reply to this request.{" "}
              <a href="/policies/privacy" className="underline underline-offset-2">Privacy policy</a>
            </p>
          </form>
        </>
      )}
    </div>
  );
}
