"use client";

import { useId, useMemo, useState } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { formatCents } from "@/lib/money";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { getSlotsAction, submitBookingAction, type BookingResult } from "./actions";

export type WizardService = {
  id: string;
  slug: string;
  name: string;
  categoryName: string;
  shortDescription: string;
  basePriceCents: number;
  baseDurationMin: number;
  adjustments: Record<string, { priceDeltaCents: number; durationDeltaMin: number }>;
  addonIds: string[];
};

export type WizardAddon = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  durationMin: number;
};

const STEPS = ["Service", "Vehicle", "Add-ons", "Time", "Details"] as const;
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950";

export function BookingWizard({
  services,
  addons,
  taxRateBp,
  taxLabel,
  preselectSlug,
  maxBookingWindowDays,
}: {
  services: WizardService[];
  addons: WizardAddon[];
  taxRateBp: number;
  taxLabel: string;
  preselectSlug?: string;
  maxBookingWindowDays: number;
}) {
  const idPrefix = useId();
  const preselected = services.find((s) => s.slug === preselectSlug);
  const [step, setStep] = useState(preselected ? 1 : 0);
  const [serviceId, setServiceId] = useState<string | null>(preselected?.id ?? null);
  const [vehicleCategory, setVehicleCategory] = useState<VehicleCategory>("sedan");
  const [vehicle, setVehicle] = useState({ year: "", make: "", model: "", colour: "" });
  const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<{ startMs: number; label: string }[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [contact, setContact] = useState({ firstName: "", lastName: "", email: "", phone: "", notes: "" });
  const [policiesAccepted, setPoliciesAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const eligibleAddons = useMemo(
    () => (service ? addons.filter((a) => service.addonIds.includes(a.id)) : []),
    [service, addons],
  );

  /** Advisory preview only — the server recomputes authoritative pricing. */
  const preview = useMemo(() => {
    if (!service) return null;
    const adj = service.adjustments[vehicleCategory];
    let subtotal = service.basePriceCents + (adj?.priceDeltaCents ?? 0);
    let duration = service.baseDurationMin + (adj?.durationDeltaMin ?? 0);
    for (const id of selectedAddons) {
      const a = addons.find((x) => x.id === id);
      if (a) {
        subtotal += a.priceCents;
        duration += a.durationMin;
      }
    }
    const tax = Math.round((subtotal * taxRateBp) / 10000);
    return { subtotal, tax, total: subtotal + tax, duration };
  }, [service, vehicleCategory, selectedAddons, addons, taxRateBp]);

  async function loadSlots(date: string) {
    if (!service || !date) return;
    setSlotsLoading(true);
    setSlotsError(null);
    setSlots(null);
    setStartMs(null);
    const res = await getSlotsAction({
      dateISO: date,
      serviceIds: [service.id],
      addonIds: selectedAddons,
      vehicleCategory,
    });
    setSlotsLoading(false);
    if (res.ok) setSlots(res.slots);
    else setSlotsError(res.error);
  }

  async function submit() {
    if (!service || !startMs || !dateISO) return;
    setSubmitting(true);
    const res = await submitBookingAction({
      serviceIds: [service.id],
      addonIds: selectedAddons,
      vehicleCategory,
      dateISO,
      startMs,
      customer: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email || undefined,
        phone: contact.phone || undefined,
        preferredContact: contact.email ? "email" : "phone",
      },
      vehicle: {
        year: vehicle.year ? Number(vehicle.year) : undefined,
        make: vehicle.make,
        model: vehicle.model,
        category: vehicleCategory,
        colour: vehicle.colour || undefined,
      },
      customerNotes: contact.notes || undefined,
      policiesAccepted: true as const,
      attribution: getStoredAttribution(),
    });
    setSubmitting(false);
    setResult(res);
  }

  if (result?.ok) {
    return (
      <div role="status" aria-live="polite" className="mx-auto max-w-xl rounded-[2rem] border border-accent-500/40 bg-gradient-to-br from-ink-900 to-ink-950 p-8 text-center shadow-2xl shadow-black/20 sm:p-10">
        <div aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-full bg-accent-400 text-2xl font-bold text-ink-950">✓</div>
        <h2 className="mt-4 text-2xl font-bold text-white">
          {result.depositUrl ? "Your appointment time is on hold" : "You’re booked!"}
        </h2>
        <p className="mt-3 text-ink-300">
          {result.whenLabel} — estimated total {result.totalLabel} (incl. {taxLabel}).
        </p>
        {result.depositLabel && result.depositUrl && (
          <div className="mt-5 rounded-2xl border border-accent-500/25 bg-[#0B2A4A]/55 p-5">
            <p className="text-sm text-ink-200">
              Your appointment is not confirmed until the {result.depositLabel} deposit is paid.
            </p>
            <a
              href={result.depositUrl}
              className={`mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 ${focusRing}`}
            >
              Pay Deposit Securely
            </a>
          </div>
        )}
        <p className="mt-4 text-sm text-ink-400">
          {result.confirmationDelivery
            ? result.depositUrl
              ? `The secure payment link was also sent by ${result.confirmationDelivery}. `
              : `A confirmation was sent by ${result.confirmationDelivery}. `
            : result.depositUrl
              ? "Please use the secure payment button above and save this reference. "
              : "We could not send a confirmation, so please save this reference. "}
          Reference:{" "}
          <span className="font-mono text-ink-300">{result.appointmentId}</span>
        </p>
      </div>
    );
  }

  const minDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + maxBookingWindowDays * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)] lg:items-start">
      <section aria-labelledby={`${idPrefix}-booking-step`} className="min-w-0 rounded-[2rem] border border-ink-700/70 bg-gradient-to-br from-ink-900/95 via-ink-900/75 to-[#0B2A4A]/25 p-5 shadow-2xl shadow-black/20 sm:p-8">
        {/* Step indicator */}
        <ol aria-label="Booking progress" className="mb-8 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          {STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={`flex min-h-11 items-center justify-center rounded-xl border px-3 py-2 text-center transition-colors ${
                i === step
                  ? "border-accent-400 bg-accent-400 font-semibold text-ink-950 shadow-lg shadow-accent-500/15"
                  : i < step
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-ink-100"
                    : "border-ink-700 bg-ink-950/50 text-ink-400"
              }`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-3">
            <h2 id={`${idPrefix}-booking-step`} className="mb-5 text-xl font-semibold text-white">Choose your service</h2>
            {services.map((s) => (
              <button
                type="button"
                key={s.id}
                aria-pressed={serviceId === s.id}
                onClick={() => {
                  setServiceId(s.id);
                  setSelectedAddons([]);
                  setSlots(null);
                  setStartMs(null);
                  setStep(1);
                }}
                className={`min-h-11 w-full rounded-2xl border p-5 text-left transition-all ${focusRing} ${
                  serviceId === s.id
                    ? "border-accent-400 bg-[#0B2A4A]/80 shadow-lg shadow-black/20"
                    : "border-ink-700 bg-ink-950/45 hover:-translate-y-0.5 hover:border-accent-500/60 hover:bg-[#0B2A4A]/35"
                }`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-ink-500">{s.categoryName}</p>
                    <p className="font-semibold text-white">{s.name}</p>
                    <p className="mt-1 text-sm text-ink-400">{s.shortDescription}</p>
                  </div>
                  <span className="shrink-0 text-accent-300">From {formatCents(s.basePriceCents)}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Tell us about your vehicle</h2>
            <fieldset>
              <legend className="mb-2 block text-sm font-medium text-ink-200">Vehicle type</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {VEHICLE_CATEGORIES.map((cat) => (
                  <button
                    type="button"
                    key={cat}
                    aria-pressed={vehicleCategory === cat}
                    onClick={() => {
                      setVehicleCategory(cat);
                      setSlots(null);
                      setStartMs(null);
                    }}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${focusRing} ${
                      vehicleCategory === cat
                        ? "border-accent-400 bg-[#0B2A4A] font-medium text-white"
                        : "border-ink-700 bg-ink-950/40 text-ink-300 hover:border-accent-500/60"
                    }`}
                  >
                    {VEHICLE_CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${idPrefix}-year`} label="Year" value={vehicle.year} onChange={(v) => setVehicle({ ...vehicle, year: v })} placeholder="2021" inputMode="numeric" />
              <Field id={`${idPrefix}-colour`} label="Colour" value={vehicle.colour} onChange={(v) => setVehicle({ ...vehicle, colour: v })} placeholder="Black" />
              <Field id={`${idPrefix}-make`} label="Make" required value={vehicle.make} onChange={(v) => setVehicle({ ...vehicle, make: v })} placeholder="Honda" />
              <Field id={`${idPrefix}-model`} label="Model" required value={vehicle.model} onChange={(v) => setVehicle({ ...vehicle, model: v })} placeholder="Civic" />
            </div>
            <StepNav
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextDisabled={!vehicle.make.trim() || !vehicle.model.trim()}
            />
          </div>
        )}

        {step === 2 && (
          <div className="max-w-lg space-y-3">
            <h2 id={`${idPrefix}-booking-step`} className="mb-5 text-xl font-semibold text-white">Customize your service</h2>
            {eligibleAddons.length === 0 && (
              <p className="text-ink-400">No add-ons available for this service.</p>
            )}
            {eligibleAddons.map((a) => {
              const checked = selectedAddons.includes(a.id);
              return (
                <button
                  type="button"
                  key={a.id}
                  aria-pressed={checked}
                  onClick={() => {
                    setSelectedAddons(
                      checked ? selectedAddons.filter((x) => x !== a.id) : [...selectedAddons, a.id],
                    );
                    setSlots(null);
                    setStartMs(null);
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left transition-colors ${focusRing} ${
                    checked ? "border-accent-400 bg-[#0B2A4A]/80" : "border-ink-700 bg-ink-950/40 hover:border-accent-500/60"
                  }`}
                >
                  <div>
                    <p className="font-medium text-white">{a.name}</p>
                    <p className="text-sm text-ink-400">{a.description}</p>
                  </div>
                  <span className="text-accent-300">+{formatCents(a.priceCents)}</span>
                </button>
              );
            })}
            <StepNav onBack={() => setStep(1)} onNext={() => setStep(3)} />
          </div>
        )}

        {step === 3 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Choose your appointment time</h2>
            <div>
              <label htmlFor={`${idPrefix}-date`} className="mb-2 block text-sm font-medium text-ink-200">Choose a date</label>
              <input
                id={`${idPrefix}-date`}
                type="date"
                min={minDate}
                max={maxDate}
                value={dateISO}
                onChange={(e) => {
                  setDateISO(e.target.value);
                  void loadSlots(e.target.value);
                }}
                className={`min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2 text-white [color-scheme:dark] sm:w-auto ${focusRing}`}
              />
            </div>
            <div aria-live="polite" aria-atomic="true">
            {slotsLoading && <p className="text-ink-300">Checking availability…</p>}
            {slotsError && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{slotsError}</p>}
            {slots && slots.length === 0 && (
              <p className="text-ink-400">
                No openings that day — please try another date.
              </p>
            )}
            {slots && slots.length > 0 && (
              <div role="group" aria-label="Available appointment times" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    type="button"
                    key={s.startMs}
                    aria-pressed={startMs === s.startMs}
                    onClick={() => setStartMs(s.startMs)}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${focusRing} ${
                      startMs === s.startMs
                        ? "border-accent-400 bg-accent-400 font-semibold text-ink-950"
                        : "border-ink-700 bg-ink-950/40 text-ink-200 hover:border-accent-500/60"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            </div>
            <StepNav onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!startMs} />
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Your contact details</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${idPrefix}-first-name`} label="First name" required autoComplete="given-name" value={contact.firstName} onChange={(v) => setContact({ ...contact, firstName: v })} />
              <Field id={`${idPrefix}-last-name`} label="Last name" required autoComplete="family-name" value={contact.lastName} onChange={(v) => setContact({ ...contact, lastName: v })} />
              <Field id={`${idPrefix}-email`} label="Email" type="email" autoComplete="email" value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} />
              <Field id={`${idPrefix}-phone`} label="Phone" type="tel" autoComplete="tel" value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-notes`} className="mb-2 block text-sm font-medium text-ink-200">Anything we should know?</label>
              <textarea
                id={`${idPrefix}-notes`}
                value={contact.notes}
                onChange={(e) => setContact({ ...contact, notes: e.target.value })}
                rows={3}
                className={`w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-3 text-white placeholder:text-ink-500 ${focusRing}`}
                placeholder="Pet hair, stains, areas of focus…"
              />
            </div>
            <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-ink-700 bg-ink-950/35 p-3 text-sm text-ink-200 ${focusRing}`}>
              <input
                type="checkbox"
                checked={policiesAccepted}
                onChange={(e) => setPoliciesAccepted(e.target.checked)}
                className="mt-0.5 size-5 shrink-0 accent-[#E0A93B]"
              />
              <span>
                I agree to the{" "}
                <a href="/policies/terms" target="_blank" className="text-accent-300 underline">
                  service terms
                </a>{" "}
                and{" "}
                <a href="/policies/cancellation" target="_blank" className="text-accent-300 underline">
                  cancellation policy
                </a>
                .
              </span>
            </label>
            {result && !result.ok && <p role="alert" aria-live="assertive" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{result.error}</p>}
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => setStep(3)} className={`min-h-11 rounded-xl border border-ink-600 px-5 py-3 text-sm text-ink-200 hover:border-accent-400 ${focusRing}`}>
                Back
              </button>
              <button
                onClick={() => void submit()}
                disabled={
                  submitting ||
                  !contact.firstName.trim() ||
                  !contact.lastName.trim() ||
                  (!contact.email.trim() && !contact.phone.trim()) ||
                  !policiesAccepted
                }
                className={`min-h-11 rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                {submitting ? "Booking…" : "Confirm Booking"}
              </button>
            </div>
            <p className="text-xs text-ink-500">
              Provide at least an email or phone number so we can confirm your appointment.
            </p>
          </div>
        )}
      </section>

      {/* Summary sidebar */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="overflow-hidden rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/25">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Live estimate</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Your booking</h3>
          {!service && <p className="mt-3 text-sm text-ink-500">Select a service to begin.</p>}
          {service && preview && (
            <div className="mt-4 space-y-2 text-sm">
              <Row label={service.name} value={formatCents(service.basePriceCents)} />
              {service.adjustments[vehicleCategory] &&
                service.adjustments[vehicleCategory].priceDeltaCents !== 0 && (
                  <Row
                    label={`${VEHICLE_CATEGORY_LABELS[vehicleCategory]} adjustment`}
                    value={`+${formatCents(service.adjustments[vehicleCategory].priceDeltaCents)}`}
                  />
                )}
              {selectedAddons.map((id) => {
                const a = addons.find((x) => x.id === id);
                return a ? <Row key={id} label={a.name} value={`+${formatCents(a.priceCents)}`} /> : null;
              })}
              <div className="my-2 border-t border-ink-700" />
              <Row label="Subtotal" value={formatCents(preview.subtotal)} />
              <Row label={taxLabel} value={formatCents(preview.tax)} />
              <div className="flex justify-between font-semibold text-white">
                <span>Estimated total</span>
                <span className="text-accent-300">{formatCents(preview.total)}</span>
              </div>
              <p className="pt-2 text-xs text-ink-500">
                Approx. {Math.floor(preview.duration / 60)}h{preview.duration % 60 ? ` ${preview.duration % 60}m` : ""} of work.
                Final price confirmed at drop-off.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  autoComplete,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink-200">{label}{required ? " *" : ""}</label>
      <input
        id={id}
        type={type}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2.5 text-white placeholder:text-ink-500 ${focusRing}`}
      />
    </div>
  );
}

function StepNav({
  onBack,
  onNext,
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 pt-3 sm:flex-row">
      <button type="button" onClick={onBack} className={`min-h-11 rounded-xl border border-ink-600 px-5 py-3 text-sm text-ink-200 hover:border-accent-400 ${focusRing}`}>
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={`min-h-11 rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        Continue
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-ink-300">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
