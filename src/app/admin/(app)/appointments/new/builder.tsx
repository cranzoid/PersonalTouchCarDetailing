"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { localDateISO } from "@/lib/tz";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { SearchSelect } from "@/components/search-select";
import {
  createManualAppointmentAction,
  getManualAppointmentSlotsAction,
  quoteManualAppointmentAction,
  type ManualQuote,
} from "../actions";

/** `searchText` carries terms worth matching but not worth showing. */
type CustomerOption = { id: string; label: string; contact: string; searchText?: string };
type VehicleOption = { id: string; customerId: string; label: string; category: string; searchText?: string };
/** Per-vehicle-category deltas, added to the base exactly as the server does. */
type SizeDeltas = { priceDeltaByCategory: Record<string, number>; durationDeltaByCategory: Record<string, number> };
type ServiceOption = SizeDeltas & {
  id: string;
  name: string;
  categoryName: string;
  description: string | null;
  basePriceCents: number;
  baseDurationMin: number;
  addonIds: string[];
};
type AddonOption = SizeDeltas & {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationMin: number;
};
/** Dollars/minutes as typed; converted on submit so a half-typed price is not a crash. */
type CustomLine = { description: string; price: string; duration: string };
/** A priced result, tagged with the selection it was priced for. */
type QuoteState = { key: string; quote: ManualQuote | null; error: string | null };

const inputClass = "w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white";

/** Minutes a new custom line starts at — a sensible half-day-of-nothing default. */
const DEFAULT_CUSTOM_DURATION_MIN = "60";

const LINE_KIND_LABELS: Record<ManualQuote["lines"][number]["kind"], string> = {
  service: "Package",
  addon: "Add-on",
  custom: "Custom",
};

function toCents(dollars: string): number {
  const value = Number(dollars);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

function toMinutes(value: string): number {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

/** "2h 30m", as the public service pages say it. */
function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** A wall-clock "HH:MM" plus minutes, as a 12-hour label that admits to crossing midnight. */
function clockAfter(time: string, minutes: number): string {
  const [hh, mm] = time.split(":").map(Number);
  const total = hh * 60 + mm + minutes;
  const days = Math.floor(total / (24 * 60));
  const inDay = total % (24 * 60);
  const hour = Math.floor(inDay / 60);
  const label = `${hour % 12 || 12}:${String(inDay % 60).padStart(2, "0")} ${hour < 12 ? "a.m." : "p.m."}`;
  return days > 0 ? `${label} (next day)` : label;
}

function formatDateISO(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function NewAppointmentBuilder({
  customers,
  vehicles,
  services,
  addons,
  maxBookingWindowDays,
  timezone,
  currency,
}: {
  customers: CustomerOption[];
  vehicles: VehicleOption[];
  services: ServiceOption[];
  addons: AddonOption[];
  maxBookingWindowDays: number;
  timezone: string;
  currency: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [customLines, setCustomLines] = useState<CustomLine[]>([]);
  const [dateISO, setDateISO] = useState("");
  const [timeMode, setTimeMode] = useState<"slots" | "override">("slots");
  const [slots, setSlots] = useState<Array<{ startMs: number; label: string }> | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [overrideTime, setOverrideTime] = useState("");
  /** What the server says an override breaks; set means "Book anyway" is on offer. */
  const [overrideWarnings, setOverrideWarnings] = useState<string[] | null>(null);
  const [notes, setNotes] = useState("");
  const [allowOutsideWindow, setAllowOutsideWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState | null>(null);
  const quoteSeq = useRef(0);

  const money = (cents: number) => formatCents(cents, currency);
  const customerVehicles = useMemo(() => vehicles.filter((vehicle) => vehicle.customerId === customerId), [vehicles, customerId]);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId);
  const vehicleCategory = selectedVehicle?.category ?? null;
  const categoryLabel = vehicleCategory
    ? VEHICLE_CATEGORY_LABELS[vehicleCategory as VehicleCategory] ?? vehicleCategory
    : null;
  const eligibleAddonIds = useMemo(() => new Set(services.filter((service) => serviceIds.includes(service.id)).flatMap((service) => service.addonIds)), [services, serviceIds]);
  const eligibleAddons = addons.filter((addon) => eligibleAddonIds.has(addon.id));
  // Blank rows are ignored rather than rejected, so an empty row left behind
  // after a change of mind does not block the booking.
  const preparedCustomLines = useMemo(
    () =>
      customLines
        .filter((line) => line.description.trim().length > 0)
        .map((line) => ({
          description: line.description.trim(),
          priceCents: toCents(line.price),
          durationMin: toMinutes(line.duration),
        })),
    [customLines],
  );
  const hasBookableLine = serviceIds.length > 0 || preparedCustomLines.length > 0;
  // Catalog services carry their own duration; an all-custom booking has one
  // only if staff typed it, and the server refuses a zero-length booking.
  const needsCustomDuration =
    serviceIds.length === 0 &&
    preparedCustomLines.length > 0 &&
    preparedCustomLines.every((line) => line.durationMin === 0);
  // Booking-window bounds mirror the public site by default. Staff can lift
  // them to record a walk-in that already happened or take a same-day job;
  // the server re-checks the same flag, and bay/staff conflicts always apply.
  // Dates are computed in the business timezone — using toISOString() here
  // rolled the calendar over for anyone working after ~8pm local. A time
  // override has no bounds at all: that is what it is for.
  const unbounded = allowOutsideWindow || timeMode === "override";
  const minDate = unbounded ? undefined : localDateISO(timezone, 86_400_000);
  const maxDate = unbounded ? undefined : localDateISO(timezone, maxBookingWindowDays * 86_400_000);

  /**
   * The exact price for the selected car, the way priceBooking adds it up —
   * base plus that size's delta. Null until a vehicle is chosen, when the only
   * honest figure is the "from" price.
   */
  function sized(base: number, baseDuration: number, deltas: SizeDeltas) {
    if (!vehicleCategory) return null;
    return {
      priceCents: base + (deltas.priceDeltaByCategory[vehicleCategory] ?? 0),
      durationMin: baseDuration + (deltas.durationDeltaByCategory[vehicleCategory] ?? 0),
    };
  }

  // Live summary, priced on the server by the same call that saves the booking,
  // so bundle discounts, deposits and vehicle size all agree with what is
  // created. Tagged with the selection it was priced for: a result that arrives
  // after staff have changed something is never shown against the new cart.
  const canQuote = Boolean(customerId && vehicleId && hasBookableLine);
  const selectionKey = JSON.stringify([customerId, vehicleId, serviceIds, addonIds, preparedCustomLines]);
  useEffect(() => {
    if (!canQuote) return;
    const seq = ++quoteSeq.current;
    const timer = setTimeout(() => {
      void quoteManualAppointmentAction({
        customerId,
        vehicleId,
        serviceIds,
        addonIds,
        customLines: preparedCustomLines,
      }).then((result) => {
        if (seq !== quoteSeq.current) return;
        setQuoteState(
          result.ok
            ? { key: selectionKey, quote: result.quote, error: null }
            : { key: selectionKey, quote: null, error: result.error },
        );
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [canQuote, selectionKey, customerId, vehicleId, serviceIds, addonIds, preparedCustomLines]);
  const current = canQuote && quoteState?.key === selectionKey ? quoteState : null;
  const quote = current?.quote ?? null;
  const quotePending = canQuote && !current;

  function resetAvailability() {
    setSlots(null);
    setStartMs(null);
    setOverrideWarnings(null);
  }

  function toggleService(id: string) {
    const next = serviceIds.includes(id) ? serviceIds.filter((value) => value !== id) : [...serviceIds, id];
    const nextAllowed = new Set(services.filter((service) => next.includes(service.id)).flatMap((service) => service.addonIds));
    setServiceIds(next);
    setAddonIds((current) => current.filter((addonId) => nextAllowed.has(addonId)));
    resetAvailability();
  }

  function toggleAddon(id: string) {
    setAddonIds(addonIds.includes(id) ? addonIds.filter((value) => value !== id) : [...addonIds, id]);
    resetAvailability();
  }

  function setCustomLine(index: number, patch: Partial<CustomLine>) {
    setCustomLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
    resetAvailability();
  }

  async function loadSlots() {
    setBusy(true);
    setError(null);
    const result = await getManualAppointmentSlotsAction({
      customerId,
      vehicleId,
      serviceIds,
      addonIds,
      customLines: preparedCustomLines,
      dateISO,
      allowOutsideBookingWindow: allowOutsideWindow,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSlots(result.slots);
    setStartMs(null);
  }

  const timeChosen = timeMode === "slots" ? startMs !== null : Boolean(dateISO && overrideTime);
  const canCreate = Boolean(customerId && vehicleId && hasBookableLine && !needsCustomDuration && dateISO && timeChosen);

  async function createAppointment(confirmOverride = false) {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const time =
      timeMode === "slots"
        ? { startMs: startMs!, allowOutsideBookingWindow: allowOutsideWindow }
        : { timeOverride: true, overrideTime, confirmOverride };
    const result = await createManualAppointmentAction({
      customerId,
      vehicleId,
      serviceIds,
      addonIds,
      customLines: preparedCustomLines,
      dateISO,
      ...time,
      customerNotes: notes || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      if ("needsOverrideConfirm" in result) return setOverrideWarnings(result.warnings);
      return setError(result.error);
    }
    router.push(`/admin/appointments/${result.appointmentId}`);
    router.refresh();
  }

  const chosenTimeLabel =
    timeMode === "slots"
      ? slots?.find((slot) => slot.startMs === startMs)?.label
      : overrideTime
        ? clockAfter(overrideTime, 0)
        : undefined;

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div className="space-y-6">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">1. Customer and vehicle</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="text-sm text-ink-300">Customer
              <SearchSelect
                label="Customer"
                className="mt-1"
                options={customers.map((customer) => ({ value: customer.id, label: customer.label, hint: customer.contact, searchText: customer.searchText }))}
                value={customerId}
                onChange={(next) => { setCustomerId(next); setVehicleId(""); resetAvailability(); }}
                placeholder="Select customer…"
                searchPlaceholder="Search name, company, email or phone"
              />
            </div>
            <div className="text-sm text-ink-300">Vehicle
              <SearchSelect
                label="Vehicle"
                className="mt-1"
                options={customerVehicles.map((vehicle) => ({ value: vehicle.id, label: vehicle.label, searchText: vehicle.searchText }))}
                value={vehicleId}
                disabled={!customerId}
                onChange={(next) => { setVehicleId(next); resetAvailability(); }}
                placeholder="Select vehicle…"
                searchPlaceholder="Search make, model, year or plate"
              />
            </div>
          </div>
          {customerId && customerVehicles.length === 0 && <p className="mt-3 text-sm text-amber-300">This customer has no vehicle. Add one from their customer record first.</p>}
          {categoryLabel && <p className="mt-3 text-sm text-ink-400">Priced as: <span className="text-white">{categoryLabel}</span> — every price below is for this size.</p>}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">2. Packages and add-ons</h2>
          <p className="mt-1 text-sm text-ink-400">
            {vehicleCategory
              ? "Prices and times are for the selected vehicle. "
              : "Choose a vehicle to see its exact prices — until then these are starting prices. "}
            Quote-only services are not listed here — book those as a custom line below.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {services.map((service) => {
              const selected = serviceIds.includes(service.id);
              const exact = sized(service.basePriceCents, service.baseDurationMin, service);
              return (
                <label
                  key={service.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${selected ? "border-accent-400 bg-accent-400/5" : "border-ink-800 hover:border-accent-500/50"}`}
                >
                  <input type="checkbox" checked={selected} onChange={() => toggleService(service.id)} className="mt-1 accent-accent-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs uppercase tracking-wide text-ink-500">{service.categoryName}</span>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-white">{service.name}</span>
                      <span className="shrink-0 text-sm font-semibold text-accent-300">
                        {exact ? money(exact.priceCents) : `From ${money(service.basePriceCents)}`}
                      </span>
                    </span>
                    <span className="block text-xs text-ink-400">
                      About {formatDuration(exact?.durationMin ?? service.baseDurationMin)}
                      {exact && categoryLabel ? ` · ${categoryLabel}` : ""}
                    </span>
                    {service.description && <span className="mt-1 block text-xs text-ink-500">{service.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          {eligibleAddons.length > 0 && (
            <div className="mt-5">
              <p className="text-sm font-medium text-ink-300">Available add-ons</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {eligibleAddons.map((addon) => {
                  const selected = addonIds.includes(addon.id);
                  const exact = sized(addon.priceCents, addon.durationMin, addon);
                  return (
                    <label
                      key={addon.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${selected ? "border-accent-400 bg-accent-400/5" : "border-ink-800 hover:border-accent-500/50"}`}
                    >
                      <input type="checkbox" checked={selected} onChange={() => toggleAddon(addon.id)} className="mt-1 accent-accent-400" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-white">{addon.name}</span>
                          <span className="shrink-0 text-ink-300">+{money(exact?.priceCents ?? addon.priceCents)}</span>
                        </span>
                        {(exact?.durationMin ?? addon.durationMin) > 0 && (
                          <span className="block text-xs text-ink-400">+{formatDuration(exact?.durationMin ?? addon.durationMin)}</span>
                        )}
                        {addon.description && <span className="mt-1 block text-xs text-ink-500">{addon.description}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">3. Custom lines</h2>
          <p className="mt-1 text-sm text-ink-400">
            For work the catalog cannot price — paint correction, PPF, or anything quoted at the
            counter. A booking can be made of custom lines alone, with no package.
          </p>
          {customLines.length > 0 && (
            <div className="mt-4 space-y-3">
              {customLines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_8rem_7rem_auto] sm:items-end">
                  <label className="text-sm text-ink-300">
                    <span className="text-xs text-ink-400">Description</span>
                    <input
                      value={line.description}
                      onChange={(event) => setCustomLine(index, { description: event.target.value })}
                      maxLength={200}
                      placeholder="Two-stage paint correction"
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                  <label className="text-sm text-ink-300">
                    <span className="text-xs text-ink-400">Price ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={line.price}
                      onChange={(event) => setCustomLine(index, { price: event.target.value })}
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                  <label className="text-sm text-ink-300">
                    <span className="text-xs text-ink-400">Minutes</span>
                    <input
                      type="number"
                      min="0"
                      max={24 * 60}
                      step="15"
                      inputMode="numeric"
                      value={line.duration}
                      onChange={(event) => setCustomLine(index, { duration: event.target.value })}
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => { setCustomLines((prev) => prev.filter((_, i) => i !== index)); resetAvailability(); }}
                    aria-label={`Remove custom line ${index + 1}`}
                    className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:border-red-500/60 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setCustomLines((prev) => [...prev, { description: "", price: "", duration: DEFAULT_CUSTOM_DURATION_MIN }])}
            className="mt-4 rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-ink-200 hover:border-accent-500/50"
          >
            Add custom line
          </button>
          {needsCustomDuration && (
            <p className="mt-3 text-sm text-amber-300">
              Give at least one custom line a duration in minutes — that is the time the bay is held for.
            </p>
          )}
          <p className="mt-3 text-xs text-ink-500">
            Custom lines are taxed like any other line and take no deposit, so a booking made only of
            them is confirmed straight away.
          </p>
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">4. Date and time</h2>
          <div className="mt-4 inline-flex rounded-lg border border-ink-700 p-1 text-sm" role="group" aria-label="How to pick the time">
            {(["slots", "override"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={timeMode === mode}
                onClick={() => { setTimeMode(mode); resetAvailability(); setError(null); }}
                className={`rounded-md px-3 py-1.5 ${timeMode === mode ? "bg-accent-400 font-semibold text-ink-950" : "text-ink-300 hover:text-white"}`}
              >
                {mode === "slots" ? "Open slots" : "Any time (override)"}
              </button>
            ))}
          </div>

          {timeMode === "slots" ? (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm text-ink-300">Date<input type="date" min={minDate} max={maxDate} value={dateISO} onChange={(event) => { setDateISO(event.target.value); resetAvailability(); }} className={`${inputClass} mt-1`} /></label>
                <button type="button" onClick={() => void loadSlots()} disabled={busy || !customerId || !vehicleId || !hasBookableLine || needsCustomDuration || !dateISO} className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Checking…" : "Check availability"}</button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
                <input
                  type="checkbox"
                  checked={allowOutsideWindow}
                  onChange={(event) => { setAllowOutsideWindow(event.target.checked); resetAvailability(); }}
                  className="accent-accent-400"
                />
                Allow past and same-day dates (walk-ins and work already done)
              </label>
              {allowOutsideWindow && (
                <p className="mt-1 text-xs text-ink-500">
                  The {maxBookingWindowDays}-day booking window and notice period are ignored. Bay and
                  staff conflicts are still checked, so a slot that would double-book is still refused.
                </p>
              )}
              {slots && slots.length === 0 && (
                <p className="mt-4 text-sm text-ink-400">
                  No openings on this date. A slot is only offered if the whole job
                  {quote ? ` (${formatDuration(quote.blockMin)} with setup and cleanup)` : ""} finishes by
                  closing time — to book a drop-off later than that, use <span className="text-white">Any time (override)</span>.
                </p>
              )}
              {slots && slots.length > 0 && <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">{slots.map((slot) => <button type="button" key={slot.startMs} onClick={() => setStartMs(slot.startMs)} className={`rounded-lg border px-3 py-2 text-sm ${startMs === slot.startMs ? "border-accent-400 bg-accent-400 font-semibold text-ink-950" : "border-ink-700 text-ink-200"}`}>{slot.label}</button>)}</div>}
            </>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm text-ink-300">Date<input type="date" value={dateISO} onChange={(event) => { setDateISO(event.target.value); resetAvailability(); }} className={`${inputClass} mt-1`} /></label>
                <label className="text-sm text-ink-300">Start time<input type="time" step={300} value={overrideTime} onChange={(event) => { setOverrideTime(event.target.value); resetAvailability(); }} className={`${inputClass} mt-1`} /></label>
              </div>
              <p className="mt-3 text-xs text-ink-500">
                Books the time exactly as entered — before opening, at or after closing, or on a day the
                shop is shut. Anything it overrides, including a bay that is already taken, is listed for
                you to confirm before it saves. Staff only: online booking still offers real slots.
              </p>
              {quote && overrideTime && (
                <p className="mt-2 text-sm text-ink-300">
                  Holds the bay {clockAfter(overrideTime, 0)} – {clockAfter(overrideTime, quote.blockMin)}
                  <span className="text-ink-500"> ({formatDuration(quote.blockMin)} including setup and cleanup)</span>
                </p>
              )}
            </>
          )}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <label className="text-sm text-ink-300">Customer/service notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} className={`${inputClass} mt-1`} /></label>
        </section>
      </div>

      <aside className="rounded-xl border border-ink-800 p-5 lg:sticky lg:top-24 lg:self-start">
        <h2 className="font-semibold text-white">Booking summary</h2>
        <div className="mt-2 text-sm text-ink-400">
          <p className="text-white">{selectedCustomer?.label ?? "No customer yet"}</p>
          {selectedVehicle && <p>{selectedVehicle.label}{categoryLabel ? ` · ${categoryLabel}` : ""}</p>}
        </div>

        {!canQuote && (
          <p className="mt-4 text-sm text-ink-500">
            Choose a customer, a vehicle and at least one package or custom line to see the price.
          </p>
        )}
        {current?.error && <p className="mt-4 text-sm text-red-300">{current.error}</p>}
        {quotePending && !quote && <p className="mt-4 text-sm text-ink-500">Pricing…</p>}
        {quote && (
          <div className={quotePending ? "opacity-60" : undefined}>
            <ul className="mt-4 space-y-2 border-t border-ink-800 pt-3 text-sm">
              {quote.lines.map((line, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-white">{line.description}</span>
                    <span className="block text-xs text-ink-500">
                      {LINE_KIND_LABELS[line.kind]}
                      {line.durationMin > 0 ? ` · ${formatDuration(line.durationMin)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-ink-200">{money(line.priceCents)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-2 border-t border-ink-800 pt-3 text-sm">
              <div className="flex justify-between text-ink-300">
                <dt>Subtotal</dt>
                <dd>{money(quote.subtotalCents)}</dd>
              </div>
              {quote.discountCents > 0 && (
                <div className="flex justify-between text-ink-300">
                  <dt>{quote.discountLabel ?? "Discount"}</dt>
                  <dd>−{money(quote.discountCents)}</dd>
                </div>
              )}
              <div className="flex justify-between text-ink-300">
                <dt>{quote.taxLabel} ({(quote.taxRateBp / 100).toFixed(2)}%)</dt>
                <dd>{money(quote.taxCents)}</dd>
              </div>
              <div className="flex justify-between border-t border-ink-800 pt-2 text-base font-semibold text-white">
                <dt>Total</dt>
                <dd>{money(quote.totalCents)}</dd>
              </div>
            </dl>
            {quote.taxCents > 0 && (
              <p className="mt-3 rounded-lg bg-ink-900 p-3 text-xs text-ink-400">
                {`Booked with ${quote.taxLabel}. If they pay cash or by e-transfer, recording that payment drops the total to `}
                <span className="text-white">{money(quote.subtotalCents - quote.discountCents)}</span>
                {"."}
              </p>
            )}
            {quote.depositRequiredCents > 0 && (
              <p className="mt-3 text-sm text-amber-300">
                Deposit required: {money(quote.depositRequiredCents)}. The booking waits as “deposit
                required” until it is recorded.
              </p>
            )}
            <p className="mt-3 text-sm text-ink-400">
              {formatDuration(quote.durationMin)} of work · bay held {formatDuration(quote.blockMin)} with setup and cleanup
            </p>
          </div>
        )}

        <div className="mt-4 border-t border-ink-800 pt-3 text-sm">
          <p className="text-ink-400">When</p>
          <p className="text-white">
            {dateISO ? formatDateISO(dateISO) : "No date yet"}
            {chosenTimeLabel ? ` at ${chosenTimeLabel}` : ""}
          </p>
          {timeMode === "override" && <p className="text-xs text-amber-300">Time override — hours are not checked</p>}
        </div>

        {overrideWarnings && (
          <div className="mt-4 rounded-lg border border-amber-800/60 p-3 text-sm text-amber-300">
            <p className="font-medium">This time overrides the schedule:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {overrideWarnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
            <button
              type="button"
              onClick={() => void createAppointment(true)}
              disabled={busy}
              className="mt-3 w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Book anyway"}
            </button>
          </div>
        )}

        <p className="mt-4 text-xs text-ink-500">
          Prices, duration and capacity are re-checked on the server when saved. A custom line keeps the
          price typed for it. Website policy acceptance is not recorded for staff-created bookings.
        </p>
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        {!overrideWarnings && (
          <button type="button" onClick={() => void createAppointment()} disabled={busy || !canCreate} className="mt-5 w-full rounded-lg bg-accent-400 px-4 py-2.5 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Create appointment"}</button>
        )}
      </aside>
    </div>
  );
}
