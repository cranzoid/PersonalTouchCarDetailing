"use client";

import { useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { submitQuoteAction, type QuoteResult } from "./actions";

type QuoteService = { id: string; name: string; slug: string; photosRequired: boolean };

export function QuoteForm({
  services,
  preselectSlug,
}: {
  services: QuoteService[];
  preselectSlug?: string;
}) {
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
      <div className="mx-auto max-w-xl rounded-2xl border border-accent-500/40 bg-ink-900/60 p-8 text-center">
        <p className="text-4xl">✓</p>
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
    "w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-white placeholder:text-ink-600";

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div>
        <p className="mb-2 text-sm font-medium text-ink-200">Which services are you interested in?</p>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => {
            const on = selected.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                onClick={() =>
                  setSelected(on ? selected.filter((x) => x !== s.id) : [...selected, s.id])
                }
                className={`rounded-full border px-4 py-2 text-sm ${
                  on
                    ? "border-accent-400 bg-accent-400/10 text-accent-300"
                    : "border-ink-700 text-ink-300 hover:border-ink-500"
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Your name *</span>
          <input required className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Email</span>
          <input type="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Phone</span>
          <input type="tel" className={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Vehicle type</span>
          <select
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
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Year</span>
          <input className={input} value={form.vehicleYear} onChange={(e) => setForm({ ...form, vehicleYear: e.target.value })} placeholder="2021" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Make &amp; model</span>
          <div className="flex gap-2">
            <input className={input} value={form.vehicleMake} onChange={(e) => setForm({ ...form, vehicleMake: e.target.value })} placeholder="Make" />
            <input className={input} value={form.vehicleModel} onChange={(e) => setForm({ ...form, vehicleModel: e.target.value })} placeholder="Model" />
          </div>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm text-ink-300">
          Describe the vehicle&apos;s condition and what you&apos;re looking for *
        </span>
        <textarea
          required
          rows={5}
          className={input}
          value={form.condition}
          onChange={(e) => setForm({ ...form, condition: e.target.value })}
          placeholder="e.g. Swirl marks on the hood and doors, interested in one-stage correction and ceramic coating…"
        />
      </label>

      <div>
        <span className="mb-1 block text-sm text-ink-300">
          Photos {photosRecommended && <span className="text-accent-300">(strongly recommended for the services selected)</span>}
        </span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 6))}
          className="block w-full text-sm text-ink-400 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-700 file:px-4 file:py-2 file:text-ink-100"
        />
        <p className="mt-1 text-xs text-ink-500">
          Up to 6 photos, 10 MB each. Photos are kept private and used only to prepare your quote.
        </p>
      </div>

      <label className="flex items-start gap-3 text-sm text-ink-400">
        <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} className="mt-1" />
        <span>Send me occasional detailing tips and offers (optional — you can unsubscribe any time).</span>
      </label>

      {result && !result.ok && <p className="text-red-400">{result.error}</p>}

      <button
        type="submit"
        disabled={submitting || !form.name.trim() || !form.condition.trim() || (!form.email.trim() && !form.phone.trim())}
        className="rounded-lg bg-accent-400 px-7 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {submitting ? "Sending…" : "Request My Quote"}
      </button>
      <p className="text-xs text-ink-500">Provide at least an email or phone number so we can reply.</p>
    </form>
  );
}
