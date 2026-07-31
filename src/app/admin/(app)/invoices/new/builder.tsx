"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { localDateISO } from "@/lib/tz";
import { createManualInvoiceAction } from "../actions";

type CustomerOption = { id: string; label: string; contact: string };
type VehicleOption = { id: string; customerId: string; label: string };
type ServiceOption = { id: string; name: string; basePriceCents: number | null };

type Line = { serviceId?: string; description: string; quantity: string; price: string };

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const labelClass = "mb-1 block text-xs text-ink-400";

const EMPTY_LINE: Line = { description: "", quantity: "1", price: "" };

/** Dollars in the UI, integer cents everywhere else. */
function toCents(dollars: string): number {
  const value = Number(dollars);
  return Number.isNaN(value) ? 0 : Math.round(value * 100);
}

export function NewInvoiceBuilder({
  customers,
  vehicles,
  services,
  taxRateBp,
  taxLabel,
  currency,
  timezone,
}: {
  customers: CustomerOption[];
  vehicles: VehicleOption[];
  services: ServiceOption[];
  taxRateBp: number;
  taxLabel: string;
  currency: string;
  timezone: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [discount, setDiscount] = useState("");
  const [invoiceDateISO, setInvoiceDateISO] = useState(() => localDateISO(timezone));
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxExemptReason, setTaxExemptReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customerVehicles = vehicles.filter((v) => v.customerId === customerId);

  // Mirrors computeInvoiceTotals on the server; the server recomputes and its
  // numbers are what get stored, so this is a preview only.
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * toCents(l.price), 0);
    const discountCents = Math.min(Math.max(0, toCents(discount)), subtotal);
    const taxable = subtotal - discountCents;
    const tax = taxExempt ? 0 : Math.round((taxable * taxRateBp) / 10000);
    return { subtotal, discountCents, tax, total: taxable + tax };
  }, [lines, discount, taxExempt, taxRateBp]);

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function pickService(index: number, serviceId: string) {
    const service = services.find((s) => s.id === serviceId);
    updateLine(index, {
      serviceId: serviceId || undefined,
      description: service ? service.name : lines[index].description,
      price: service?.basePriceCents != null ? (service.basePriceCents / 100).toFixed(2) : lines[index].price,
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createManualInvoiceAction({
      customerId,
      vehicleId: vehicleId || undefined,
      lines: lines
        .filter((l) => l.description.trim())
        .map((l) => ({
          serviceId: l.serviceId,
          description: l.description,
          quantity: Number(l.quantity || 1),
          unitPriceCents: toCents(l.price),
        })),
      discountCents: toCents(discount),
      invoiceDateISO,
      taxExempt,
      taxExemptReason: taxExempt ? taxExemptReason : undefined,
      notes: notes || undefined,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/invoices/${result.invoiceId}`);
  }

  const money = (cents: number) => formatCents(cents, currency);

  return (
    <form onSubmit={submit} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
      <div className="space-y-6">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">1. Customer</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Customer</span>
              <select
                className={inputClass}
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setVehicleId("");
                }}
                required
              >
                <option value="">Select customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} — {c.contact}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Vehicle (optional)</span>
              <select
                className={inputClass}
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                disabled={!customerId}
              >
                <option value="">No vehicle</option>
                {customerVehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            Not in the list?{" "}
            <Link href="/admin/customers" className="text-accent-300 underline">
              Add the customer first
            </Link>
            , then come back.
          </p>
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">2. Work performed</h2>
          <div className="mt-4 space-y-3">
            {lines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_2rem] sm:items-end">
                <div className="grid gap-2">
                  <select
                    className={`${inputClass} text-ink-300`}
                    value={line.serviceId ?? ""}
                    onChange={(e) => pickService(index, e.target.value)}
                  >
                    <option value="">Custom item…</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                  />
                </div>
                <label className="block">
                  <span className={labelClass}>Qty</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Unit price ($)</span>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={line.price}
                    onChange={(e) => updateLine(index, { price: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  disabled={lines.length === 1}
                  aria-label={`Remove line ${index + 1}`}
                  className="mb-2 text-ink-400 hover:text-red-300 disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
            className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800"
          >
            Add line
          </button>
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">3. Date, discount and tax</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Invoice date (may be backdated)</span>
              <input
                type="date"
                className={inputClass}
                value={invoiceDateISO}
                onChange={(e) => setInvoiceDateISO(e.target.value)}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Discount ($)</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </label>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              className="accent-accent-400"
              checked={taxExempt}
              onChange={(e) => setTaxExempt(e.target.checked)}
            />
            Do not charge {taxLabel} on this invoice
          </label>
          {taxExempt && (
            <label className="mt-3 block">
              <span className={labelClass}>Reason (required — shown on the invoice and the tax report)</span>
              <input
                className={inputClass}
                value={taxExemptReason}
                onChange={(e) => setTaxExemptReason(e.target.value)}
                placeholder="e.g. Cash sale, out-of-province customer, exempt organisation"
              />
            </label>
          )}

          <label className="mt-4 block">
            <span className={labelClass}>Notes (appear on the invoice)</span>
            <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </section>
      </div>

      <aside className="rounded-xl border border-ink-800 p-5 lg:sticky lg:top-24">
        <h2 className="font-semibold text-white">Totals</h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between text-ink-300">
            <dt>Subtotal</dt>
            <dd>{money(totals.subtotal)}</dd>
          </div>
          {totals.discountCents > 0 && (
            <div className="flex justify-between text-ink-300">
              <dt>Discount</dt>
              <dd>−{money(totals.discountCents)}</dd>
            </div>
          )}
          <div className="flex justify-between text-ink-300">
            <dt>
              {taxLabel} {taxExempt ? "(exempt)" : `(${(taxRateBp / 100).toFixed(2)}%)`}
            </dt>
            <dd>{money(totals.tax)}</dd>
          </div>
          <div className="flex justify-between border-t border-ink-800 pt-2 text-base font-semibold text-white">
            <dt>Total</dt>
            <dd>{money(totals.total)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-500">
          Totals are recalculated on the server when saved. The invoice is created as a draft — review
          it, then send it to the customer.
        </p>
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy || !customerId || !lines.some((l) => l.description.trim())}
          className="mt-4 w-full rounded-lg bg-accent-400 px-4 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create invoice"}
        </button>
      </aside>
    </form>
  );
}
