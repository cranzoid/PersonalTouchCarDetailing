"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { localDateISO } from "@/lib/tz";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import {
  VehicleDialog,
  vehicleLabel,
  vehiclePayload,
  type VehicleFormValues,
} from "@/components/vehicle-dialog";
import { addCustomerVehicleAction } from "../../customers/actions";
import { createManualInvoiceAction } from "../actions";

type CustomerOption = { id: string; label: string; contact: string };
type VehicleOption = { id: string; customerId: string; category: string; label: string };
type ServiceOption = {
  id: string;
  name: string;
  categoryName: string;
  basePriceCents: number | null;
  active: boolean;
  priceDeltaByCategory: Record<string, number>;
  addonIds: string[];
};
type AddonOption = {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  /** Per-vehicle-category deltas, same meaning as a service's. */
  priceDeltaByCategory: Record<string, number>;
};

/** A selected catalog item; `override` is a staff-entered price in dollars. */
type Picked = { quantity: number; override: string };
type CustomLine = { description: string; quantity: string; price: string };

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const labelClass = "mb-1 block text-xs text-ink-400";

function toCents(dollars: string): number {
  const value = Number(dollars);
  return Number.isNaN(value) ? 0 : Math.round(value * 100);
}

export function NewInvoiceBuilder({
  customers,
  vehicles,
  services,
  addons,
  taxRateBp,
  taxLabel,
  currency,
  timezone,
  initialCustomerId = "",
  initialVehicleId = "",
}: {
  customers: CustomerOption[];
  vehicles: VehicleOption[];
  services: ServiceOption[];
  addons: AddonOption[];
  taxRateBp: number;
  taxLabel: string;
  currency: string;
  timezone: string;
  /** Preselected when staff come back from "add the customer first". */
  initialCustomerId?: string;
  initialVehicleId?: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [vehicleId, setVehicleId] = useState(initialVehicleId);
  // A vehicle added from the dialog is held here as well as sent to the server,
  // so it is selectable immediately without a page round-trip.
  const [addedVehicles, setAddedVehicles] = useState<VehicleOption[]>([]);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);
  const [vehicleBusy, setVehicleBusy] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);
  const [pickedServices, setPickedServices] = useState<Record<string, Picked>>({});
  const [pickedAddons, setPickedAddons] = useState<Record<string, Picked>>({});
  const [customLines, setCustomLines] = useState<CustomLine[]>([]);
  const [discountMode, setDiscountMode] = useState<"amount" | "percent">("amount");
  const [discount, setDiscount] = useState("");
  const [invoiceDateISO, setInvoiceDateISO] = useState(() => localDateISO(timezone));
  const [discountReason, setDiscountReason] = useState("");
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxExemptReason, setTaxExemptReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const knownVehicles = [...vehicles, ...addedVehicles];
  const customerVehicles = knownVehicles.filter((v) => v.customerId === customerId);
  const selectedVehicle = knownVehicles.find((v) => v.id === vehicleId);
  const vehicleCategory = selectedVehicle?.category ?? null;

  const money = (cents: number) => formatCents(cents, currency);

  /** Catalog price for the currently selected vehicle size. */
  function servicePrice(service: ServiceOption): number | null {
    if (service.basePriceCents === null) return null;
    const delta = vehicleCategory ? (service.priceDeltaByCategory[vehicleCategory] ?? 0) : 0;
    return service.basePriceCents + delta;
  }

  /**
   * The same rule for an add-on. This has to exist: the server prices add-ons
   * for the vehicle when it builds the invoice, so quoting the base price in
   * the grid meant the figure staff read here disagreed with the invoice they
   * were about to create — and inviting them to "correct" it with an override
   * would have locked in the wrong price for real.
   */
  function addonPrice(addon: AddonOption): number {
    const delta = vehicleCategory ? (addon.priceDeltaByCategory[vehicleCategory] ?? 0) : 0;
    return addon.priceCents + delta;
  }

  // Only add-ons linked to a chosen service can be billed — same rule the
  // booking flow enforces server-side.
  const eligibleAddons = useMemo(() => {
    const allowed = new Set(
      services.filter((s) => pickedServices[s.id]).flatMap((s) => s.addonIds),
    );
    return addons.filter((a) => allowed.has(a.id));
  }, [services, addons, pickedServices]);

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceOption[]>();
    for (const service of services) {
      const list = map.get(service.categoryName) ?? [];
      list.push(service);
      map.set(service.categoryName, list);
    }
    return [...map.entries()];
  }, [services]);

  // Preview only — the server re-resolves every catalog price on save.
  const totals = useMemo(() => {
    let subtotal = 0;
    for (const [id, picked] of Object.entries(pickedServices)) {
      const service = services.find((s) => s.id === id);
      if (!service) continue;
      const unit = picked.override.trim() ? toCents(picked.override) : (servicePrice(service) ?? 0);
      subtotal += unit * picked.quantity;
    }
    for (const [id, picked] of Object.entries(pickedAddons)) {
      const addon = addons.find((a) => a.id === id);
      if (!addon) continue;
      const unit = picked.override.trim() ? toCents(picked.override) : addonPrice(addon);
      subtotal += unit * picked.quantity;
    }
    for (const line of customLines) {
      subtotal += Number(line.quantity || 0) * toCents(line.price);
    }
    const raw =
      discountMode === "percent"
        ? Math.round((subtotal * Math.round(Number(discount || 0) * 100)) / 10000)
        : toCents(discount);
    const discountCents = Math.min(Math.max(0, raw), subtotal);
    const taxable = subtotal - discountCents;
    const tax = taxExempt ? 0 : Math.round((taxable * taxRateBp) / 10000);
    return { subtotal, discountCents, tax, total: taxable + tax };
  }, [pickedServices, pickedAddons, customLines, discount, discountMode, taxExempt, taxRateBp, services, addons, vehicleCategory]);

  function toggleService(id: string) {
    setPickedServices((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { quantity: 1, override: "" };
      return next;
    });
    // Dropping a service can orphan its add-ons; clear any that are no longer
    // offered by something still selected.
    setPickedAddons((prev) => {
      const stillSelected = { ...pickedServices };
      if (stillSelected[id]) delete stillSelected[id];
      else stillSelected[id] = { quantity: 1, override: "" };
      const allowed = new Set(
        services.filter((s) => stillSelected[s.id]).flatMap((s) => s.addonIds),
      );
      return Object.fromEntries(Object.entries(prev).filter(([addonId]) => allowed.has(addonId)));
    });
  }

  /**
   * Adds a vehicle to the customer already selected here.
   *
   * Goes through addCustomerVehicleAction rather than a new write path, so the
   * gate stays `manage_customers`: an accountant may raise invoices but not
   * edit the CRM, and the action tells them so rather than this screen quietly
   * widening what their role can do.
   */
  async function saveNewVehicle(values: VehicleFormValues) {
    setVehicleBusy(true);
    setVehicleError(null);
    const payload = vehiclePayload(values);
    const result = await addCustomerVehicleAction({ customerId, ...payload });
    setVehicleBusy(false);
    if (!result.ok) return setVehicleError(result.error);
    setAddedVehicles((prev) => [
      ...prev,
      {
        id: result.vehicleId,
        customerId,
        category: payload.category,
        label: vehicleLabel(payload),
      },
    ]);
    // Selected straight away: the whole point is that package prices re-price
    // for this size without leaving the half-built invoice.
    setVehicleId(result.vehicleId);
    setVehicleDialogOpen(false);
    router.refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const lines = [
      ...Object.entries(pickedServices).map(([serviceId, picked]) => ({
        kind: "service" as const,
        serviceId,
        quantity: picked.quantity,
        unitPriceCents: picked.override.trim() ? toCents(picked.override) : undefined,
      })),
      ...Object.entries(pickedAddons).map(([addonId, picked]) => ({
        kind: "addon" as const,
        addonId,
        quantity: picked.quantity,
        unitPriceCents: picked.override.trim() ? toCents(picked.override) : undefined,
      })),
      ...customLines
        .filter((l) => l.description.trim())
        .map((l) => ({
          kind: "custom" as const,
          description: l.description,
          quantity: Number(l.quantity || 1),
          unitPriceCents: toCents(l.price),
        })),
    ];

    const result = await createManualInvoiceAction({
      customerId,
      vehicleId: vehicleId || undefined,
      lines,
      ...(discountMode === "percent"
        ? { discountPercentBp: Math.round(Number(discount || 0) * 100) }
        : { discountCents: toCents(discount) }),
      invoiceDateISO,
      discountReason: discountReason || undefined,
      taxExempt,
      taxExemptReason: taxExempt ? taxExemptReason : undefined,
      notes: notes || undefined,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/invoices/${result.invoiceId}`);
  }

  const lineCount =
    Object.keys(pickedServices).length +
    Object.keys(pickedAddons).length +
    customLines.filter((l) => l.description.trim()).length;

  return (
    <form onSubmit={submit} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
      <div className="space-y-6">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">1. Customer and vehicle</h2>
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
            <div>
              <label className="block">
                <span className={labelClass}>Vehicle (sets package pricing)</span>
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
              <button
                type="button"
                onClick={() => {
                  setVehicleError(null);
                  setVehicleDialogOpen(true);
                }}
                disabled={!customerId}
                className="mt-2 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:border-ink-500 disabled:opacity-40"
              >
                + Add vehicle
              </button>
            </div>
          </div>
          {selectedVehicle && (
            <p className="mt-3 text-sm text-ink-400">
              Pricing size:{" "}
              <span className="text-white">
                {VEHICLE_CATEGORY_LABELS[selectedVehicle.category as VehicleCategory] ?? selectedVehicle.category}
              </span>{" "}
              — package prices below reflect this vehicle.
            </p>
          )}
          {customerId && !vehicleId && (
            <p className="mt-3 text-sm text-amber-300">
              Pick a vehicle to price packages by size. Without one, base prices are used.
            </p>
          )}
          <p className="mt-3 text-xs text-ink-500">
            Customer not in the list?{" "}
            <Link
              href={`/admin/customers?new=1&next=${encodeURIComponent("/admin/invoices/new")}`}
              className="text-accent-300 underline"
            >
              Add them now
            </Link>
            {" "}— you will come back here with them selected.
          </p>

          {vehicleDialogOpen && (
            <VehicleDialog
              title="Add a vehicle"
              description="Added to this customer's record and selected on this invoice."
              submitLabel="Add vehicle"
              busy={vehicleBusy}
              error={vehicleError}
              onCancel={() => setVehicleDialogOpen(false)}
              onSubmit={(values) => void saveNewVehicle(values)}
            />
          )}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">2. Packages and services</h2>
          <div className="mt-4 space-y-5">
            {grouped.map(([categoryName, list]) => (
              <div key={categoryName}>
                <p className="mb-2 text-xs uppercase tracking-wide text-ink-500">{categoryName}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {list.map((service) => {
                    const picked = pickedServices[service.id];
                    const price = servicePrice(service);
                    return (
                      <div
                        key={service.id}
                        className={`rounded-lg border p-3 ${picked ? "border-accent-500/60" : "border-ink-800"}`}
                      >
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={Boolean(picked)}
                            onChange={() => toggleService(service.id)}
                            className="mt-1 accent-accent-400"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-white">
                              {service.name}
                              {!service.active && <span className="ml-2 text-xs text-ink-500">(retired)</span>}
                            </span>
                            <span className="block text-xs text-ink-400">
                              {price === null ? "Price on quote" : money(price)}
                            </span>
                          </span>
                        </label>
                        {picked && (
                          <div className="mt-3 flex items-end gap-2">
                            <label className="block">
                              <span className={labelClass}>Qty</span>
                              <input
                                className={`${inputClass} w-16`}
                                inputMode="numeric"
                                value={picked.quantity}
                                onChange={(e) =>
                                  setPickedServices((prev) => ({
                                    ...prev,
                                    [service.id]: { ...prev[service.id], quantity: Math.max(1, Number(e.target.value) || 1) },
                                  }))
                                }
                              />
                            </label>
                            <label className="block flex-1">
                              <span className={labelClass}>
                                {price === null ? "Price ($) — required" : "Override price ($)"}
                              </span>
                              <input
                                className={inputClass}
                                inputMode="decimal"
                                placeholder={price === null ? "0.00" : (price / 100).toFixed(2)}
                                value={picked.override}
                                onChange={(e) =>
                                  setPickedServices((prev) => ({
                                    ...prev,
                                    [service.id]: { ...prev[service.id], override: e.target.value },
                                  }))
                                }
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {eligibleAddons.length > 0 && (
          <section className="rounded-xl border border-ink-800 p-5">
            <h2 className="font-semibold text-white">3. Add-ons</h2>
            <p className="mt-1 text-sm text-ink-400">Extras available with the services selected above.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {eligibleAddons.map((addon) => {
                const picked = pickedAddons[addon.id];
                return (
                  <div
                    key={addon.id}
                    className={`rounded-lg border p-3 ${picked ? "border-accent-500/60" : "border-ink-800"}`}
                  >
                    <label className="flex cursor-pointer items-center gap-3 text-sm text-white">
                      <input
                        type="checkbox"
                        checked={Boolean(picked)}
                        onChange={() =>
                          setPickedAddons((prev) => {
                            const next = { ...prev };
                            if (next[addon.id]) delete next[addon.id];
                            else next[addon.id] = { quantity: 1, override: "" };
                            return next;
                          })
                        }
                        className="accent-accent-400"
                      />
                      {addon.name}
                      <span className="ml-auto text-ink-400">+{money(addonPrice(addon))}</span>
                    </label>
                    {picked && (
                      <div className="mt-3 flex items-end gap-2">
                        <label className="block">
                          <span className={labelClass}>Qty</span>
                          <input
                            className={`${inputClass} w-16`}
                            inputMode="numeric"
                            value={picked.quantity}
                            onChange={(e) =>
                              setPickedAddons((prev) => ({
                                ...prev,
                                [addon.id]: { ...prev[addon.id], quantity: Math.max(1, Number(e.target.value) || 1) },
                              }))
                            }
                          />
                        </label>
                        <label className="block flex-1">
                          <span className={labelClass}>Override price ($)</span>
                          <input
                            className={inputClass}
                            inputMode="decimal"
                            placeholder={(addonPrice(addon) / 100).toFixed(2)}
                            value={picked.override}
                            onChange={(e) =>
                              setPickedAddons((prev) => ({
                                ...prev,
                                [addon.id]: { ...prev[addon.id], override: e.target.value },
                              }))
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">Custom lines</h2>
          <p className="mt-1 text-sm text-ink-400">Anything not in the catalogue.</p>
          <div className="mt-4 space-y-3">
            {customLines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_2rem] sm:items-end">
                <label className="block">
                  <span className={labelClass}>Description</span>
                  <input
                    className={inputClass}
                    value={line.description}
                    onChange={(e) =>
                      setCustomLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)),
                      )
                    }
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Qty</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={(e) =>
                      setCustomLines((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))
                    }
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Unit price ($)</span>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={line.price}
                    onChange={(e) =>
                      setCustomLines((prev) => prev.map((l, i) => (i === index ? { ...l, price: e.target.value } : l)))
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setCustomLines((prev) => prev.filter((_, i) => i !== index))}
                  aria-label={`Remove custom line ${index + 1}`}
                  className="mb-2 text-ink-400 hover:text-red-300"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setCustomLines((prev) => [...prev, { description: "", quantity: "1", price: "" }])}
            className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800"
          >
            Add custom line
          </button>
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">Date, discount and tax</h2>
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
            <div>
              <span className={labelClass}>Discount</span>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  placeholder={discountMode === "percent" ? "10" : "25.00"}
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
                <div className="flex shrink-0 overflow-hidden rounded-lg border border-ink-600">
                  {(["amount", "percent"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDiscountMode(mode)}
                      className={`px-3 py-2 text-sm ${
                        discountMode === mode ? "bg-accent-400 font-semibold text-ink-950" : "text-ink-300"
                      }`}
                    >
                      {mode === "amount" ? "$" : "%"}
                    </button>
                  ))}
                </div>
              </div>
              {discountMode === "percent" && totals.discountCents > 0 && (
                <p className="mt-1 text-xs text-ink-500">= {money(totals.discountCents)} off</p>
              )}
            </div>
          </div>

          {totals.discountCents > 0 && (
            <label className="mt-4 block">
              <span className={labelClass}>Why the discount? (optional — shown on the invoice)</span>
              <input
                className={inputClass}
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
                placeholder="e.g. Repeat customer, service recovery, referral thank-you"
              />
            </label>
          )}

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
        <p className="mt-1 text-xs text-ink-500">
          {lineCount === 0 ? "No lines yet" : `${lineCount} line${lineCount === 1 ? "" : "s"}`}
        </p>
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
        {!taxExempt && totals.subtotal > 0 && taxRateBp > 0 && (
          <p className="mt-3 rounded-lg bg-ink-900 p-3 text-xs text-ink-400">
            {`Invoiced with ${taxLabel}. If they settle in cash or by e-transfer, recording that payment drops the total to `}
            <span className="text-white">{money(totals.subtotal - totals.discountCents)}</span>
            {"."}
          </p>
        )}
        <p className="mt-3 text-xs text-ink-500">
          Package prices are re-resolved on the server from the vehicle size when saved. The invoice is
          created as a draft — review it, then send it.
        </p>
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy || !customerId || lineCount === 0}
          className="mt-4 w-full rounded-lg bg-accent-400 px-4 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create invoice"}
        </button>
      </aside>
    </form>
  );
}
