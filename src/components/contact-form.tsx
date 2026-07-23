"use client";

import { useId, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { submitContactAction, type ContactResult } from "@/app/(public)/contact/actions";

export function ContactForm({ kind = "contact" }: { kind?: "contact" | "fleet" }) {
  const idPrefix = useId();
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", message: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ContactResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await submitContactAction({
      ...form,
      email: form.email || undefined,
      phone: form.phone || undefined,
      company: form.company || undefined,
      kind,
      attribution: getStoredAttribution(),
    });
    setSubmitting(false);
    setResult(res);
  }

  if (result?.ok) {
    return (
      <div role="status" aria-live="polite" className="rounded-[2rem] border border-accent-500/40 bg-gradient-to-br from-ink-900 to-ink-950 p-8 text-center shadow-2xl shadow-black/20">
        <div aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-full bg-accent-400 text-2xl font-bold text-ink-950">✓</div>
        <h2 className="mt-4 text-xl font-bold text-white">Message received</h2>
        <p className="mt-2 text-ink-300">We&apos;ll get back to you within one business day.</p>
      </div>
    );
  }

  const input =
    "min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2.5 text-white placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950";

  return (
    <form aria-busy={submitting} onSubmit={submit} className="space-y-5 rounded-[2rem] border border-ink-700/70 bg-gradient-to-br from-ink-900/95 via-ink-900/75 to-[#0B2A4A]/25 p-5 shadow-2xl shadow-black/20 sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={`${idPrefix}-name`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Name *</span>
          <input id={`${idPrefix}-name`} required autoComplete="name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        {kind === "fleet" && (
          <label htmlFor={`${idPrefix}-company`} className="block">
            <span className="mb-2 block text-sm font-medium text-ink-200">Company *</span>
            <input id={`${idPrefix}-company`} required autoComplete="organization" className={input} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </label>
        )}
        <label htmlFor={`${idPrefix}-email`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Email</span>
          <input id={`${idPrefix}-email`} type="email" autoComplete="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label htmlFor={`${idPrefix}-phone`} className="block">
          <span className="mb-2 block text-sm font-medium text-ink-200">Phone</span>
          <input id={`${idPrefix}-phone`} type="tel" autoComplete="tel" className={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
      </div>
      <label htmlFor={`${idPrefix}-message`} className="block">
        <span className="mb-2 block text-sm font-medium text-ink-200">
          {kind === "fleet" ? "Tell us about your fleet and needs *" : "How can we help? *"}
        </span>
        <textarea id={`${idPrefix}-message`} required rows={5} className={input} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
      </label>
      {result && !result.ok && <p role="alert" aria-live="assertive" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{result.error}</p>}
      <button
        type="submit"
        disabled={submitting || (!form.email.trim() && !form.phone.trim())}
        className="min-h-11 w-full rounded-xl bg-accent-400 px-7 py-3 font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        {submitting ? "Sending…" : "Send Message"}
      </button>
      <p className="text-xs text-ink-500">Provide at least an email or phone number so we can reply.</p>
    </form>
  );
}
