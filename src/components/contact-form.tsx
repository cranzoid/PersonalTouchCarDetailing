"use client";

import { useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { submitContactAction, type ContactResult } from "@/app/(public)/contact/actions";

export function ContactForm({ kind = "contact" }: { kind?: "contact" | "fleet" }) {
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
      <div className="rounded-2xl border border-accent-500/40 bg-ink-900/60 p-8 text-center">
        <p className="text-4xl">✓</p>
        <h2 className="mt-4 text-xl font-bold text-white">Message received</h2>
        <p className="mt-2 text-ink-300">We&apos;ll get back to you within one business day.</p>
      </div>
    );
  }

  const input =
    "w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-white placeholder:text-ink-600";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Name *</span>
          <input required className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        {kind === "fleet" && (
          <label className="block">
            <span className="mb-1 block text-sm text-ink-300">Company *</span>
            <input required className={input} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Email</span>
          <input type="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-300">Phone</span>
          <input type="tel" className={input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-sm text-ink-300">
          {kind === "fleet" ? "Tell us about your fleet and needs *" : "How can we help? *"}
        </span>
        <textarea required rows={5} className={input} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
      </label>
      {result && !result.ok && <p className="text-red-400">{result.error}</p>}
      <button
        type="submit"
        disabled={submitting || (!form.email.trim() && !form.phone.trim())}
        className="rounded-lg bg-accent-400 px-7 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {submitting ? "Sending…" : "Send Message"}
      </button>
      <p className="text-xs text-ink-500">Provide at least an email or phone number so we can reply.</p>
    </form>
  );
}
