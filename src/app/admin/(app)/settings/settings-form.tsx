"use client";

import { useState } from "react";
import type { BusinessSettings } from "@/lib/settings";
import { updateSettingsAction } from "./actions";

export function SettingsForm({ initial }: { initial: BusinessSettings }) {
  const [form, setForm] = useState({
    businessName: initial.businessName,
    addressLine1: initial.addressLine1,
    city: initial.city,
    province: initial.province,
    postalCode: initial.postalCode,
    phone: initial.phone,
    email: initial.email,
    taxRatePct: (initial.taxRateBp / 100).toFixed(2),
    taxRegistrationNumber: initial.taxRegistrationNumber,
    slotGranularityMin: String(initial.slotGranularityMin),
    setupBufferMin: String(initial.setupBufferMin),
    cleanupBufferMin: String(initial.cleanupBufferMin),
    minBookingNoticeHours: String(initial.minBookingNoticeHours),
    maxBookingWindowDays: String(initial.maxBookingWindowDays),
    cancellationNoticeHours: String(initial.cancellationNoticeHours),
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await updateSettingsAction({
      businessName: form.businessName,
      addressLine1: form.addressLine1,
      city: form.city,
      province: form.province,
      postalCode: form.postalCode,
      phone: form.phone,
      email: form.email,
      taxRateBp: Math.round(Number(form.taxRatePct) * 100),
      taxRegistrationNumber: form.taxRegistrationNumber,
      slotGranularityMin: Number(form.slotGranularityMin),
      setupBufferMin: Number(form.setupBufferMin),
      cleanupBufferMin: Number(form.cleanupBufferMin),
      minBookingNoticeHours: Number(form.minBookingNoticeHours),
      maxBookingWindowDays: Number(form.maxBookingWindowDays),
      cancellationNoticeHours: Number(form.cancellationNoticeHours),
    });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: res.error });
  }

  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
  const label = "mb-1 block text-xs text-ink-400";

  function field(key: keyof typeof form, title: string, props: Record<string, unknown> = {}) {
    return (
      <label className="block">
        <span className={label}>{title}</span>
        <input
          className={input}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          {...props}
        />
      </label>
    );
  }

  return (
    <form onSubmit={save} className="mt-8 space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Identity</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("businessName", "Business name")}
          {field("phone", "Phone *")}
          {field("email", "Email *")}
          {field("addressLine1", "Street address *")}
          {field("city", "City")}
          {field("province", "Province")}
          {field("postalCode", "Postal code *")}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Tax</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("taxRatePct", "Tax rate % (Ontario HST = 13)")}
          {field("taxRegistrationNumber", "HST registration number *")}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Booking rules</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("slotGranularityMin", "Slot granularity (min)")}
          {field("setupBufferMin", "Setup buffer (min)")}
          {field("cleanupBufferMin", "Cleanup buffer (min)")}
          {field("minBookingNoticeHours", "Min notice (hours)")}
          {field("maxBookingWindowDays", "Booking window (days)")}
          {field("cancellationNoticeHours", "Cancellation notice (hours)")}
        </div>
      </section>
      {msg && <p className={msg.ok ? "text-sm text-emerald-300" : "text-sm text-red-400"}>{msg.text}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save Settings"}
      </button>
    </form>
  );
}
