"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, taxCents } from "@/lib/money";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS } from "@/lib/types";
import { createEstimateAction } from "../actions";

type ServiceOption = {
  id: string;
  name: string;
  basePriceCents: number | null;
  baseDurationMin: number;
};

type Prefill = {
  quoteRequestId: string;
  name: string;
  email: string;
  phone: string;
  vehicle: { year?: number; make?: string; model?: string; category?: string } | null;
  requestedServiceIds: string[];
  conditionDescription: string;
} | null;

type Line = {
  serviceId: string | null;
  description: string;
  quantity: number;
  /** Dollars string for editing; converted to cents on submit. */
  unitPrice: string;
  isOptional: boolean;
};

const HST_BP = 1300; // preview only — the server snapshots the configured rate

function toCents(dollars: string): number {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function EstimateBuilder({
  services,
  prefill,
}: {
  services: ServiceOption[];
  prefill: Prefill;
}) {
  const router = useRouter();
  const nameParts = (prefill?.name ?? "").split(/\s+/);
  const [firstName, setFirstName] = useState(nameParts[0] ?? "");
  const [lastName, setLastName] = useState(nameParts.slice(1).join(" "));
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [phone, setPhone] = useState(prefill?.phone ?? "");
  const [vehicleMake, setVehicleMake] = useState(prefill?.vehicle?.make ?? "");
  const [vehicleModel, setVehicleModel] = useState(prefill?.vehicle?.model ?? "");
  const [vehicleYear, setVehicleYear] = useState(prefill?.vehicle?.year ? String(prefill.vehicle.year) : "");
  const [vehicleCategory, setVehicleCategory] = useState(prefill?.vehicle?.category ?? "sedan");
  const [lines, setLines] = useState<Line[]>(() =>
    (prefill?.requestedServiceIds ?? [])
      .map((id) => services.find((s) => s.id === id))
      .filter((s): s is ServiceOption => Boolean(s))
      .map((s) => ({
        serviceId: s.id,
        description: s.name,
        quantity: 1,
        unitPrice: s.basePriceCents !== null ? (s.basePriceCents / 100).toFixed(2) : "0.00",
        isOptional: false,
      })),
  );
  const [discount, setDiscount] = useState("0");
  const [deposit, setDeposit] = useState("0");
  const [validDays, setValidDays] = useState("30");
  const [customerMessage, setCustomerMessage] = useState("");
  const [internalNotes, setInternalNotes] = useState(
    prefill?.conditionDescription ? `Customer described: ${prefill.conditionDescription}` : "",
  );
  const [serviceToAdd, setServiceToAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * toCents(l.unitPrice), 0);
    const disc = Math.min(Math.max(0, toCents(discount)), subtotal);
    const tax = taxCents(subtotal - disc, HST_BP);
    return { subtotal, disc, tax, total: subtotal - disc + tax };
  }, [lines, discount]);

  function addServiceLine() {
    const svc = services.find((s) => s.id === serviceToAdd);
    if (!svc) return;
    setLines((prev) => [
      ...prev,
      {
        serviceId: svc.id,
        description: svc.name,
        quantity: 1,
        unitPrice: svc.basePriceCents !== null ? (svc.basePriceCents / 100).toFixed(2) : "0.00",
        isOptional: false,
      },
    ]);
    setServiceToAdd("");
  }

  function addCustomLine() {
    setLines((prev) => [
      ...prev,
      { serviceId: null, description: "", quantity: 1, unitPrice: "0.00", isOptional: false },
    ]);
  }

  function setLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (lines.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    if (lines.some((l) => !l.description.trim())) {
      setError("Every line needs a description.");
      return;
    }
    setBusy(true);
    const res = await createEstimateAction({
      quoteRequestId: prefill?.quoteRequestId,
      customer: { firstName, lastName, email, phone },
      vehicle: vehicleMake && vehicleModel
        ? {
            make: vehicleMake,
            model: vehicleModel,
            year: vehicleYear ? Number(vehicleYear) : undefined,
            category: vehicleCategory as (typeof VEHICLE_CATEGORIES)[number],
          }
        : undefined,
      lines: lines.map((l) => ({
        serviceId: l.serviceId,
        description: l.description.trim(),
        quantity: l.quantity,
        unitPriceCents: toCents(l.unitPrice),
        isOptional: l.isOptional,
      })),
      discountCents: toCents(discount),
      depositRequiredCents: toCents(deposit),
      customerMessage: customerMessage.trim() || undefined,
      internalNotes: internalNotes.trim() || undefined,
      validDays: Number(validDays) || 30,
    });
    setBusy(false);
    if (res.ok) router.push(`/admin/estimates/${res.estimateId}`);
    else setError(res.error);
  }

  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
  const label = "mb-1 block text-xs text-ink-400";

  return (
    <form onSubmit={submit} className="mt-8 space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Customer</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className={label}>First name</span>
            <input className={input} value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></label>
          <label className="block"><span className={label}>Last name</span>
            <input className={input} value={lastName} onChange={(e) => setLastName(e.target.value)} /></label>
          <label className="block"><span className={label}>Email</span>
            <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="block"><span className={label}>Phone</span>
            <input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Vehicle</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block"><span className={label}>Year</span>
            <input className={input} value={vehicleYear} onChange={(e) => setVehicleYear(e.target.value)} /></label>
          <label className="block"><span className={label}>Make</span>
            <input className={input} value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} /></label>
          <label className="block"><span className={label}>Model</span>
            <input className={input} value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} /></label>
          <label className="block"><span className={label}>Size</span>
            <select className={input} value={vehicleCategory} onChange={(e) => setVehicleCategory(e.target.value)}>
              {VEHICLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{VEHICLE_CATEGORY_LABELS[c]}</option>
              ))}
            </select></label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Line items</h2>
        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="rounded-xl border border-ink-800 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_auto]">
                <input
                  className={input}
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
                <input
                  className={input}
                  type="number"
                  min={1}
                  max={99}
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                  title="Quantity"
                />
                <input
                  className={input}
                  inputMode="decimal"
                  value={l.unitPrice}
                  onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                  title="Unit price ($)"
                />
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  className="rounded-lg border border-ink-700 px-3 text-xs text-ink-400 hover:border-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
                <input
                  type="checkbox"
                  checked={l.isOptional}
                  onChange={(e) => setLine(i, { isOptional: e.target.checked })}
                />
                Optional — customer can include or skip this item
              </label>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <select className={`${input} w-auto`} value={serviceToAdd} onChange={(e) => setServiceToAdd(e.target.value)}>
            <option value="">Add from catalog…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.basePriceCents !== null ? ` — ${formatCents(s.basePriceCents)}` : " (quote)"}
              </option>
            ))}
          </select>
          <button type="button" onClick={addServiceLine} disabled={!serviceToAdd}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-400 disabled:opacity-40">
            Add Service
          </button>
          <button type="button" onClick={addCustomLine}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-400">
            Add Custom Line
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Pricing</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block"><span className={label}>Discount ($)</span>
            <input className={input} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>
          <label className="block"><span className={label}>Deposit required ($)</span>
            <input className={input} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></label>
          <label className="block"><span className={label}>Valid for (days)</span>
            <input className={input} type="number" min={1} max={365} value={validDays} onChange={(e) => setValidDays(e.target.value)} /></label>
        </div>
        <div className="mt-4 rounded-xl border border-ink-800 p-4 text-sm text-ink-300">
          <p>Subtotal: <strong className="text-white">{formatCents(totals.subtotal)}</strong></p>
          {totals.disc > 0 && <p>Discount: −{formatCents(totals.disc)}</p>}
          <p>HST (13%): {formatCents(totals.tax)}</p>
          <p className="mt-1 text-base">Total: <strong className="text-accent-300">{formatCents(totals.total)}</strong></p>
          <p className="mt-1 text-xs text-ink-500">
            Preview uses 13% HST; the saved estimate snapshots the configured tax rate.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Notes</h2>
        <div className="grid gap-3">
          <label className="block"><span className={label}>Message shown to the customer</span>
            <textarea className={input} rows={3} value={customerMessage} onChange={(e) => setCustomerMessage(e.target.value)} /></label>
          <label className="block"><span className={label}>Internal notes (staff only)</span>
            <textarea className={input} rows={3} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} /></label>
        </div>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create Draft Estimate"}
      </button>
    </form>
  );
}
