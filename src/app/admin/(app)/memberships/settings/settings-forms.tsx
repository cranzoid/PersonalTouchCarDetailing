"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MembershipSettings } from "@/lib/memberships/config";
import { saveMembershipSettingsAction, savePlanAction, schedulePlanChangeAction } from "../actions";

const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const label = "block text-xs text-ink-400";
const button = "rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40";
const BENEFITS = [
  { key: "wash", label: "Monthly premium hand wash" },
  { key: "interior", label: "Monthly basic interior clean" },
];

type Plan = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  features: string[];
  monthlyPriceCents: number;
  discountBp: number;
  includedBenefits: string[];
  rank: number;
  active: boolean;
  sort: number;
};

function useResult() {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) {
    setBusy(true);
    setMessage(null);
    const result = await fn();
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: result.message ?? "Saved." } : { ok: false, text: result.error });
    if (result.ok) router.refresh();
  }
  const view = message && <p className={`text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>;
  return { run, busy, view };
}

export function PlanEditor({ plan, members }: { plan: Plan | null; members: number }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => ({
    slug: plan?.slug ?? "",
    name: plan?.name ?? "",
    tagline: plan?.tagline ?? "",
    features: (plan?.features ?? []).join("\n"),
    price: plan ? (plan.monthlyPriceCents / 100).toFixed(2) : "",
    discount: plan ? String(plan.discountBp / 100) : "0",
    benefits: plan?.includedBenefits ?? ["wash"],
    rank: String(plan?.rank ?? 1),
    sort: String(plan?.sort ?? 10),
    active: plan?.active ?? true,
  }));
  const { run, busy, view } = useResult();

  if (!plan && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-dashed border-ink-600 px-4 py-3 text-sm text-ink-300 hover:bg-ink-900">
        + Add a plan
      </button>
    );
  }

  function save() {
    return run(() =>
      savePlanAction({
        id: plan?.id,
        slug: form.slug,
        name: form.name,
        tagline: form.tagline,
        features: form.features.split("\n").map((f) => f.trim()).filter(Boolean),
        monthlyPriceCents: Math.round(Number(form.price) * 100),
        discountBp: Math.round(Number(form.discount) * 100),
        includedBenefits: form.benefits,
        rank: Number(form.rank),
        active: form.active,
        sort: Number(form.sort),
      }),
    );
  }

  return (
    <div className="rounded-xl border border-ink-800 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white">{plan ? plan.name : "New plan"}</p>
        {plan && <p className="text-xs text-ink-400">{members} live member{members === 1 ? "" : "s"}{plan.active ? "" : " · not on sale"}</p>}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className={label}>Name<input className={`${input} mt-1`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className={label}>Monthly price (before tax)<input className={`${input} mt-1`} inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
        <label className={label}>Member discount %<input className={`${input} mt-1`} inputMode="decimal" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} /></label>
        <label className={`${label} sm:col-span-2`}>Tagline<input className={`${input} mt-1`} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} /></label>
        <label className={label}>URL name (slug)<input className={`${input} mt-1 font-mono`} value={form.slug} disabled={Boolean(plan)} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></label>
        <label className={`${label} sm:col-span-2`}>
          What the plan lists (one per line — shown on /winter)
          <textarea className={`${input} mt-1 min-h-32`} value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} />
        </label>
        <div className="space-y-3">
          <fieldset>
            <legend className={label}>Included each month</legend>
            {BENEFITS.map((b) => (
              <label key={b.key} className="mt-2 flex items-center gap-2 text-sm text-ink-200">
                <input
                  type="checkbox"
                  checked={form.benefits.includes(b.key)}
                  onChange={(e) => setForm({ ...form, benefits: e.target.checked ? [...form.benefits, b.key] : form.benefits.filter((k) => k !== b.key) })}
                />
                {b.label}
              </label>
            ))}
          </fieldset>
          <label className={label}>Tier (higher = upgrade)<input className={`${input} mt-1`} inputMode="numeric" value={form.rank} onChange={(e) => setForm({ ...form, rank: e.target.value })} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            On sale
          </label>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" disabled={busy} className={button} onClick={() => void save()}>{busy ? "Saving…" : "Save plan"}</button>
        {view}
      </div>
    </div>
  );
}

export function SeasonChange({ plans, defaultFromISO }: { plans: { id: string; name: string; active: boolean }[]; defaultFromISO: string }) {
  const [fromPlanId, setFromPlanId] = useState(plans[0]?.id ?? "");
  const [toPlanId, setToPlanId] = useState(plans.find((p) => p.id !== plans[0]?.id)?.id ?? "");
  const [fromDate, setFromDate] = useState(defaultFromISO);
  const { run, busy, view } = useResult();
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-ink-800 p-5">
      <label className={label}>Members of<select className={`${input} mt-1`} value={fromPlanId} onChange={(e) => setFromPlanId(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className={label}>move to<select className={`${input} mt-1`} value={toPlanId} onChange={(e) => setToPlanId(e.target.value)}>{plans.filter((p) => p.id !== fromPlanId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (not on sale)"}</option>)}</select></label>
      <label className={label}>from<input type="date" className={`${input} mt-1`} value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
      <button type="button" disabled={busy || !toPlanId || toPlanId === fromPlanId} className={button} onClick={() => void run(() => schedulePlanChangeAction({ fromPlanId, toPlanId, fromDate }))}>
        Schedule for all
      </button>
      <div className="w-full">{view}</div>
    </div>
  );
}

export function MembershipSettingsForm({ initial, services }: { initial: MembershipSettings; services: { slug: string; name: string }[] }) {
  const [form, setForm] = useState({
    salesOpen: initial.salesOpen,
    passSalesOpen: initial.passSalesOpen,
    passName: initial.winterPass.name,
    passPrice: (initial.winterPass.priceCents / 100).toFixed(2),
    passWashes: String(initial.winterPass.washesTotal),
    passFrom: initial.winterPass.validFrom,
    passUntil: initial.winterPass.validUntil,
    passFeatures: initial.winterPass.features.join("\n"),
    discountServiceSlugs: initial.discountServiceSlugs,
    discountAddons: initial.discountAddons,
    priorityDays: String(initial.priorityBookingExtraDays),
    retryDays: initial.retryDays.join(", "),
    noticeDays: String(initial.planChangeNoticeDays),
    termsVersion: initial.termsVersion,
  });
  const { run, busy, view } = useResult();

  function save() {
    return run(() =>
      saveMembershipSettingsAction({
        salesOpen: form.salesOpen,
        passSalesOpen: form.passSalesOpen,
        winterPass: {
          name: form.passName,
          priceCents: Math.round(Number(form.passPrice) * 100),
          washesTotal: Number(form.passWashes),
          validFrom: form.passFrom,
          validUntil: form.passUntil,
          features: form.passFeatures.split("\n").map((f) => f.trim()).filter(Boolean),
        },
        discountServiceSlugs: form.discountServiceSlugs,
        discountAddons: form.discountAddons,
        priorityBookingExtraDays: Number(form.priorityDays),
        retryDays: form.retryDays.split(/[,\s]+/).filter(Boolean).map(Number),
        planChangeNoticeDays: Number(form.noticeDays),
        termsVersion: form.termsVersion,
      }),
    );
  }

  return (
    <div className="mt-3 space-y-6 rounded-xl border border-ink-800 p-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-white">On sale online</legend>
        <p className="text-xs text-amber-300">Leave these off until Helcim is set up in Integrations and a test payment has gone through.</p>
        <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={form.salesOpen} onChange={(e) => setForm({ ...form, salesOpen: e.target.checked })} />Memberships can be bought online</label>
        <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={form.passSalesOpen} onChange={(e) => setForm({ ...form, passSalesOpen: e.target.checked })} />Winter Pass can be bought online</label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-white">Winter Pass</legend>
        <label className={label}>Name<input className={`${input} mt-1`} value={form.passName} onChange={(e) => setForm({ ...form, passName: e.target.value })} /></label>
        <label className={label}>Price (before tax)<input className={`${input} mt-1`} inputMode="decimal" value={form.passPrice} onChange={(e) => setForm({ ...form, passPrice: e.target.value })} /></label>
        <label className={label}>Washes<input className={`${input} mt-1`} inputMode="numeric" value={form.passWashes} onChange={(e) => setForm({ ...form, passWashes: e.target.value })} /></label>
        <label className={label}>Usable from<input type="date" className={`${input} mt-1`} value={form.passFrom} onChange={(e) => setForm({ ...form, passFrom: e.target.value })} /></label>
        <label className={label}>Usable until<input type="date" className={`${input} mt-1`} value={form.passUntil} onChange={(e) => setForm({ ...form, passUntil: e.target.value })} /></label>
        <label className={`${label} sm:col-span-3`}>What the pass lists (one per line)<textarea className={`${input} mt-1 min-h-24`} value={form.passFeatures} onChange={(e) => setForm({ ...form, passFeatures: e.target.value })} /></label>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-white">Member discount applies to</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {services.map((service) => (
            <label key={service.slug} className="flex items-center gap-2 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={form.discountServiceSlugs.includes(service.slug)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    discountServiceSlugs: e.target.checked ? [...form.discountServiceSlugs, service.slug] : form.discountServiceSlugs.filter((s) => s !== service.slug),
                  })
                }
              />
              {service.name}
            </label>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={form.discountAddons} onChange={(e) => setForm({ ...form, discountAddons: e.target.checked })} />
          Also add-ons booked with one of those packages
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold text-white">Booking and billing</legend>
        <label className={label}>Priority booking: extra days ahead<input className={`${input} mt-1`} inputMode="numeric" value={form.priorityDays} onChange={(e) => setForm({ ...form, priorityDays: e.target.value })} /></label>
        <label className={label}>Retry failed charges after (days)<input className={`${input} mt-1`} value={form.retryDays} onChange={(e) => setForm({ ...form, retryDays: e.target.value })} /></label>
        <label className={label}>Plan-change notice (days)<input className={`${input} mt-1`} inputMode="numeric" value={form.noticeDays} onChange={(e) => setForm({ ...form, noticeDays: e.target.value })} /></label>
        <label className={label}>Terms version<input className={`${input} mt-1 font-mono`} value={form.termsVersion} onChange={(e) => setForm({ ...form, termsVersion: e.target.value })} /></label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="button" disabled={busy} className={button} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button>
        {view}
      </div>
    </div>
  );
}
