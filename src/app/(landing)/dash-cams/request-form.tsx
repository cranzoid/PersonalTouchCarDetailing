"use client";

import { useEffect, useId, useRef, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackGa4Event, trackRequestQuoteConversion } from "@/components/google-tag";
import { trackMetaLead } from "@/components/meta-pixel";
import { DASH_CAM_ENQUIRY_TYPE, DASH_CAM_PAGE_PATH } from "@/lib/dash-cam-offer";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { submitQuoteAction, type QuoteResult } from "../../(public)/quote/actions";

const inputClass =
  "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-base text-[#0B2A4A] placeholder:text-slate-400 focus:border-[#0B2A4A] focus:outline-none focus:ring-2 focus:ring-[#E0A93B]/50 disabled:opacity-60";
const eventContext = { offer: DASH_CAM_ENQUIRY_TYPE, page_path: DASH_CAM_PAGE_PATH };

/**
 * Callback request for dash cam installation. Same fields as the ceramic
 * callback form (vehicle type, name, phone), plus an optional email. It goes
 * through the public quote action, so it lands in Leads → Quote requests with
 * the usual follow-up date, tagged `dash_cam`.
 */
export function DashCamRequestForm({ priceLabel, phone }: { priceLabel: string; phone: string }) {
  const id = useId();
  const [category, setCategory] = useState<VehicleCategory>("sedan");
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
        trackGa4Event("dash_cam_view", eventContext);
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
    trackGa4Event("dash_cam_start", eventContext);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setResult(null);
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get("email") ?? "").trim();
    const payload = new FormData();
    payload.set("payload", JSON.stringify({
      name: fields.get("name"),
      phone: fields.get("phone"),
      email,
      serviceIds: [],
      vehicleCategory: category,
      conditionDescription:
        `Dash cam installation request (from ${priceLabel}, installation included). Vehicle: ${VEHICLE_CATEGORY_LABELS[category]}. ` +
        "Please call back to confirm details and arrange a time.",
      marketingConsent: false,
      attribution: { ...getStoredAttribution(), enquiryPage: DASH_CAM_PAGE_PATH, enquiryType: DASH_CAM_ENQUIRY_TYPE },
    }));
    try {
      const response = await submitQuoteAction(payload);
      setResult(response);
      if (response.ok) {
        // A lead is counted only after the server action has persisted it.
        trackMetaLead({ content_name: "Dash Cam Installation", content_category: "callback_request" });
        trackRequestQuoteConversion();
        trackGa4Event("dash_cam_success", { ...eventContext, vehicle_category: category });
      } else {
        trackGa4Event("dash_cam_error", { ...eventContext, error_type: "server_rejected" });
      }
    } catch {
      setResult({ ok: false, error: "We couldn’t send your request. Please try again or call us." });
      trackGa4Event("dash_cam_error", { ...eventContext, error_type: "network" });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div id="request" className="scroll-mt-6 rounded-[1.5rem] border border-white/30 bg-[#FFFEFB] p-5 text-[#0B2A4A] shadow-[0_24px_70px_#00000040] sm:p-7">
      {result?.ok ? (
        <div role="status" aria-live="polite" className="py-4">
          <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-[#E5EEDC] text-2xl">✓</span>
          <h2 className="mt-4 text-2xl font-extrabold">Request received!</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            Thank you! We’ll call you to confirm the details and arrange your dash cam installation. Nothing has been charged.
          </p>
          <p className="mt-4 break-all text-xs text-slate-500">Reference: {result.reference}</p>
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-[#E0A93B] px-4 font-bold">
            Prefer to talk now? {phone}
          </a>
        </div>
      ) : (
        <>
          <p className="text-xs font-bold uppercase tracking-[0.17em] text-[#80570F]">Dash cam installation</p>
          <h2 className="mt-2 text-2xl font-extrabold tracking-tight">Get a call back</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">From {priceLabel}, installation included. Leave your details and we’ll ring you.</p>
          <form onSubmit={submit} onFocusCapture={start} aria-busy={busy} className="mt-5 space-y-4">
            <label className="block" htmlFor={`${id}-vehicle`}>
              <span className="mb-1.5 block text-sm font-bold">Your vehicle type</span>
              <select
                id={`${id}-vehicle`}
                className={inputClass}
                value={category}
                disabled={busy}
                onChange={(event) => setCategory(event.target.value as VehicleCategory)}
              >
                {VEHICLE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{VEHICLE_CATEGORY_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-name`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Your name</span>
              <input id={`${id}-name`} name="name" autoComplete="name" required maxLength={150} disabled={busy} className={inputClass} />
            </label>
            <label htmlFor={`${id}-phone`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Phone number</span>
              <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required minLength={7} maxLength={30} disabled={busy} className={inputClass} />
            </label>
            <label htmlFor={`${id}-email`} className="block">
              <span className="mb-1.5 block text-sm font-bold">Email <span className="font-normal text-slate-500">(optional)</span></span>
              <input id={`${id}-email`} name="email" type="email" autoComplete="email" maxLength={200} disabled={busy} className={inputClass} />
            </label>
            {result && !result.ok && (
              <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
                {result.error} <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="font-bold underline">Call {phone}</a>
              </p>
            )}
            <button type="submit" disabled={busy} className="min-h-14 w-full rounded-xl bg-[#E0A93B] px-4 py-3 text-lg font-extrabold text-[#0B2A4A] transition hover:bg-[#EDC66F] disabled:cursor-wait disabled:opacity-60">
              {busy ? "Sending…" : "Request my call back →"}
            </button>
            <p className="text-center text-xs leading-5 text-slate-600">
              No payment now. We use your details only to reply to this request.{" "}
              <a href="/policies/privacy" className="underline underline-offset-2">Privacy policy</a>
            </p>
          </form>
        </>
      )}
    </div>
  );
}
