"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackGa4Event, trackRequestQuoteConversion } from "@/components/google-tag";
import { trackMetaLead } from "@/components/meta-pixel";
import { formatCents } from "@/lib/money";
import { CERAMIC_PROTECTION_SLUG } from "@/lib/ceramic";
import type { VehicleCategory } from "@/lib/types";
import { submitQuoteAction, type QuoteResult } from "../../quote/actions";

const inputClass = "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base text-[#0B2A4A] focus:border-[#0B2A4A]";
const eventContext = { service: CERAMIC_PROTECTION_SLUG, page_path: "/services/ceramic-protection" };

export function CeramicEnquiry({ serviceId, vehiclePrices, taxLabel, currency, phone, bookable }: {
  serviceId: string;
  vehiclePrices: { category: VehicleCategory; label: string; priceCents: number | null }[];
  taxLabel: string;
  currency: string;
  phone: string;
  bookable: boolean;
}) {
  const id = useId();
  const [category, setCategory] = useState<VehicleCategory>("sedan");
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const submitting = useRef(false);
  const viewed = useRef(false);
  const selected = vehiclePrices.find((row) => row.category === category)!;
  const bookUrl = `/book?service=${CERAMIC_PROTECTION_SLUG}`;

  useEffect(() => {
    // afterInteractive tag initialization can follow this component's mount.
    let attempts = 0;
    function recordView() {
      if (!viewed.current && typeof window.gtag === "function") {
        viewed.current = true;
        trackGa4Event("ceramic_landing_view", eventContext);
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
    trackGa4Event("ceramic_enquiry_start", eventContext);
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
      phone: fields.get("phone"),
      serviceIds: [serviceId],
      vehicleCategory: category,
      conditionDescription: `Ceramic protection callback request. Vehicle: ${selected.label}. Please confirm price and available appointments.`,
      marketingConsent: false,
      attribution: { ...getStoredAttribution(), enquiryPage: eventContext.page_path, enquiryType: "ceramic_callback" },
    }));
    trackGa4Event("ceramic_enquiry_submit", { ...eventContext, vehicle_category: category });
    try {
      const response = await submitQuoteAction(payload);
      setResult(response);
      if (response.ok) {
        // A lead is counted only after the existing server action persists it.
        trackMetaLead({ content_name: "Ceramic Protection Enquiry", content_category: "callback_request" });
        trackRequestQuoteConversion();
        trackGa4Event("ceramic_enquiry_success", { ...eventContext, vehicle_category: category });
      } else {
        trackGa4Event("ceramic_enquiry_error", { ...eventContext, error_type: "server_rejected" });
      }
    } catch {
      setResult({ ok: false, error: "We couldn’t confirm your request. Please try again or call us." });
      trackGa4Event("ceramic_enquiry_error", { ...eventContext, error_type: "network" });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div id="ceramic-enquiry" className="scroll-mt-28 rounded-[1.5rem] border border-white/30 bg-[#FFFEFB] p-5 text-[#0B2A4A] shadow-[0_24px_70px_#00000030] sm:p-7">
      {result?.ok ? (
        <div role="status" aria-live="polite" className="py-6">
          <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-[#E5EEDC] text-2xl">✓</span>
          <h2 className="mt-4 text-2xl font-bold">Your request is in.</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">We’ll contact you about ceramic protection for your vehicle, confirm pricing and discuss appointments. No time has been reserved yet.</p>
          <p className="mt-4 break-all text-xs text-slate-500">Reference: {result.reference}</p>
          <a href={`tel:${phone}`} className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-[#E0A93B] px-4 font-bold">Prefer to talk now? {phone}</a>
          {bookable && <Link href={bookUrl} className="mt-3 flex min-h-12 items-center justify-center font-semibold underline underline-offset-4">Or book an appointment online →</Link>}
        </div>
      ) : (
        <>
          <p className="text-xs font-bold uppercase tracking-[0.17em] text-[#80570F]">Start with your vehicle</p>
          <h2 className="mt-2 text-2xl font-extrabold tracking-tight">Let’s get your car protected.</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">See your price, then ask us to call about availability.</p>
          <form onSubmit={submit} onFocusCapture={start} aria-busy={busy} className="mt-5 space-y-4">
            <label className="block" htmlFor={`${id}-vehicle`}>
              <span className="mb-1.5 block text-sm font-bold">Your vehicle type</span>
              <select id={`${id}-vehicle`} className={inputClass} value={category} disabled={busy} onChange={(event) => {
                const value = event.target.value as VehicleCategory;
                setCategory(value);
                trackGa4Event("ceramic_vehicle_selected", { ...eventContext, vehicle_category: value });
              }}>
                {vehiclePrices.map((row) => <option key={row.category} value={row.category}>{row.label}</option>)}
              </select>
            </label>
            <div aria-live="polite" aria-atomic="true" className="rounded-xl border border-[#E6D8B8] bg-[#F8F1E2] px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">Standalone protection</p>
                <p className="text-3xl font-extrabold tracking-tight">{selected.priceCents === null ? "By quote" : formatCents(selected.priceCents, currency).replace(/\.00$/, "")}</p>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-600">{selected.priceCents === null ? "We’ll confirm pricing for your commercial vehicle." : `${selected.label} · ${currency}, before ${taxLabel}. No detail purchase needed.`}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <label htmlFor={`${id}-name`}>
                <span className="mb-1.5 block text-sm font-bold">Your name</span>
                <input id={`${id}-name`} name="name" autoComplete="name" required maxLength={150} disabled={busy} className={inputClass} />
              </label>
              <label htmlFor={`${id}-phone`}>
                <span className="mb-1.5 block text-sm font-bold">Phone number</span>
                <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required minLength={7} maxLength={30} disabled={busy} className={inputClass} />
              </label>
            </div>
            {result && !result.ok && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{result.error} <a href={`tel:${phone}`} className="font-bold underline">Call {phone}</a></p>}
            <button type="submit" disabled={busy} className="min-h-14 w-full rounded-xl bg-[#E0A93B] px-4 py-3 font-extrabold text-[#0B2A4A] transition hover:bg-[#EDC66F] disabled:cursor-wait disabled:opacity-60">{busy ? "Sending your request…" : "Call me about availability →"}</button>
            <p className="text-center text-xs leading-5 text-slate-600">No payment or account needed. We’ll use your details to respond to this request. <Link href="/policies/privacy" className="underline underline-offset-2">Privacy policy</Link></p>
          </form>
          {bookable && <div className="mt-5 border-t border-[#DED8CE] pt-4 text-center"><p className="text-xs text-slate-600">Already know what you want?</p><Link href={bookUrl} className="inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">Choose an appointment online →</Link></div>}
        </>
      )}
    </div>
  );
}
