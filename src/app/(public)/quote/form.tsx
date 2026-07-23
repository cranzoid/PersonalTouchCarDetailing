"use client";

import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { submitQuoteAction, type QuoteResult } from "./actions";

type QuoteService = { id: string; name: string; slug: string; photosRequired: boolean };
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950";

export function QuoteForm({
  services,
  preselectSlug,
}: {
  services: QuoteService[];
  preselectSlug?: string;
}) {
  const idPrefix = useId();
  const preselected = services.find((s) => s.slug === preselectSlug);
  const [selected, setSelected] = useState<string[]>(preselected ? [preselected.id] : []);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    vehicleYear: "",
    vehicleMake: "",
    vehicleModel: "",
    colour: "",
    condition: "",
  });
  const [vehicleCategory, setVehicleCategory] = useState<VehicleCategory | "">("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuoteResult | null>(null);

  const photosRecommended = services.some((s) => selected.includes(s.id) && s.photosRequired);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const fd = new FormData();
    fd.set(
      "payload",
      JSON.stringify({
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        serviceIds: selected,
        vehicleYear: form.vehicleYear ? Number(form.vehicleYear) : undefined,
        vehicleMake: form.vehicleMake || undefined,
        vehicleModel: form.vehicleModel || undefined,
        vehicleCategory: vehicleCategory || undefined,
        conditionDescription: form.condition,
        marketingConsent,
        attribution: getStoredAttribution(),
      }),
    );
    for (const p of photos) fd.append("photos", p);
    const res = await submitQuoteAction(fd);
    setSubmitting(false);
    setResult(res);
  }

  if (result?.ok) {
    return (
      <div role="status" aria-live="polite" className="mx-auto max-w-xl rounded-[2rem] border border-accent-500/40 bg-gradient-to-br from-ink-900 to-ink-950 p-8 text-center shadow-2xl shadow-black/20 sm:p-10">
        <div aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-full bg-accent-400 text-2xl font-bold text-ink-950">✓</div>
        <h2 className="mt-4 text-2xl font-bold text-white">Quote request received</h2>
        <p className="mt-3 text-ink-300">
          Thanks — we&apos;ll review your details and get back to you within one business day.
        </p>
        <p className="mt-4 text-sm text-ink-400">
          Reference: <span className="font-mono text-ink-300">{result.reference}</span>
        </p>
      </div>
    );
  }

  const input =
    `min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2.5 text-white placeholder:text-ink-500 ${focusRing}`;

  return (
    <form aria-busy={submitting} onSubmit={submit} className="max-w-3xl space-y-7 rounded-[2rem] border border-ink-700/70 bg-gradient-to-br from-ink-900/95 via-ink-900/75 to-[#0B2A4A]/25 p-5 shadow-2xl shadow-black/20 sm:p-8">
      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-ink-100">Which services are you interested in?</legend>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => {
            const on = selected.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                aria-pressed={on}
                onClick={() =>
                  setSelected(on ? selected.filter((x) => x !== s.id) : [...selected, s.id])
                }
                className={`min-h-11 rounded-xl border px-4 py-2 text-sm transition-colors ${focusRing} ${
                  on
                    ? "border-accent-400 bg-[#0B2A4A] font-medium text-white"
                    : "border-ink-700 bg-ink-950/40 text-ink-300 hover:border-accent-500/60"
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={`${idPrefix}-name`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Your name *</span>
          <input id={`${idPrefix}-name`} required autoComplete="name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label htmlFor={`${idPrefix}-email`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Email</span>
          <input id={`${idPrefix}-email`} type="email" autoComplete="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label htmlFor={`${idPrefix}-phone`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Phone</span>
          <input id={`${idPrefix}-phone`} type="tel" autoComplete="tel" className={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label htmlFor={`${idPrefix}-vehicle-type`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Vehicle type</span>
          <select
            id={`${idPrefix}-vehicle-type`}
            className={input}
            value={vehicleCategory}
            onChange={(e) => setVehicleCategory(e.target.value as VehicleCategory | "")}
          >
            <option value="">Select…</option>
            {VEHICLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {VEHICLE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-year`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Year</span>
          <input id={`${idPrefix}-year`} inputMode="numeric" className={input} value={form.vehicleYear} onChange={(e) => setForm({ ...form, vehicleYear: e.target.value })} placeholder="2021" />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label htmlFor={`${idPrefix}-make`} className="block"><span className="mb-2 block text-sm font-medium text-ink-200">Make</span><input id={`${idPrefix}-make`} className={input} value={form.vehicleMake} onChange={(e) => setForm({ ...form, vehicleMake: e.target.value })} placeholder="Honda" /></label>
          <label htmlFor={`${idPrefix}-model`} className="block"><span className="mb-2 block text-sm font-medium text-ink-200">Model</span><input id={`${idPrefix}-model`} className={input} value={form.vehicleModel} onChange={(e) => setForm({ ...form, vehicleModel: e.target.value })} placeholder="Civic" /></label>
        </div>
      </div>

      <label htmlFor={`${idPrefix}-condition`} className="block">
        <span className="mb-2 block text-sm font-medium text-ink-200">
          Describe the vehicle&apos;s condition and what you&apos;re looking for *
        </span>
        <textarea
          id={`${idPrefix}-condition`}
          required
          rows={5}
          className={input}
          value={form.condition}
          onChange={(e) => setForm({ ...form, condition: e.target.value })}
          placeholder="e.g. Swirl marks on the hood and doors, interested in one-stage correction and ceramic coating…"
        />
      </label>

      <div>
        <label htmlFor={`${idPrefix}-photos`} className="mb-2 block text-sm font-medium text-ink-200">
          Photos {photosRecommended && <span className="text-accent-300">(strongly recommended for the services selected)</span>}
        </label>
        <input
          id={`${idPrefix}-photos`}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 6))}
          className={`block min-h-11 w-full rounded-xl border border-dashed border-ink-600 bg-ink-950/35 p-2 text-sm text-ink-300 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-[#0B2A4A] file:px-4 file:py-2 file:font-medium file:text-ink-100 ${focusRing}`}
          aria-describedby={`${idPrefix}-photo-help`}
        />
        <p id={`${idPrefix}-photo-help`} className="mt-2 text-xs text-ink-400">
          Up to 6 photos, 10 MB each. Photos are kept private and used only to prepare your quote.
        </p>
      </div>

      <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-ink-700 bg-ink-950/35 p-3 text-sm text-ink-300 ${focusRing}`}>
        <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[#E0A93B]" />
        <span>Send me occasional detailing tips and offers (optional — you can unsubscribe any time).</span>
      </label>

      {result && !result.ok && <p role="alert" aria-live="assertive" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{result.error}</p>}

      <button
        type="submit"
        disabled={submitting || !form.name.trim() || !form.condition.trim() || (!form.email.trim() && !form.phone.trim())}
        className={`min-h-11 w-full rounded-xl bg-accent-400 px-7 py-3 font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto ${focusRing}`}
      >
        {submitting ? "Sending…" : "Request My Quote"}
      </button>
      <p className="text-xs text-ink-500">Provide at least an email or phone number so we can reply.</p>
    </form>
  );
}
