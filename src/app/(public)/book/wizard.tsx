"use client";

import { useMemo, useState } from "react";
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
      <div className="mx-auto max-w-xl rounded-2xl border border-accent-500/40 bg-ink-900/60 p-8 text-center">
        <p className="text-4xl">✓</p>
        <h2 className="mt-4 text-2xl font-bold text-white">You&apos;re booked!</h2>
        <p className="mt-3 text-ink-300">
          {result.whenLabel} — estimated total {result.totalLabel} (incl. {taxLabel}).
        </p>
        {result.depositLabel && (
          <p className="mt-2 text-sm text-accent-300">
            A deposit of {result.depositLabel} is required to confirm this booking — we&apos;ll
            contact you with payment instructions.
          </p>
        )}
        <p className="mt-4 text-sm text-ink-400">
          A confirmation has been sent to your contact details. Reference:{" "}
          <span className="font-mono text-ink-300">{result.appointmentId}</span>
        </p>
      </div>
    );
  }

  const minDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + maxBookingWindowDays * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="grid gap-10 lg:grid-cols-[2fr_1fr]">
      <div>
        {/* Step indicator */}
        <ol className="mb-8 flex flex-wrap gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`rounded-full px-3 py-1 ${
                i === step
                  ? "bg-accent-400 font-semibold text-ink-950"
                  : i < step
                    ? "bg-ink-700 text-ink-200"
                    : "bg-ink-900 text-ink-500"
              }`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-3">
            {services.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setServiceId(s.id);
                  setSelectedAddons([]);
                  setSlots(null);
                  setStartMs(null);
                  setStep(1);
                }}
                className={`w-full rounded-xl border p-4 text-left transition-colors ${
                  serviceId === s.id
                    ? "border-accent-400 bg-ink-800"
                    : "border-ink-700 bg-ink-900/50 hover:border-ink-500"
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
            <div>
              <label className="mb-1 block text-sm text-ink-300">Vehicle type</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {VEHICLE_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => {
                      setVehicleCategory(cat);
                      setSlots(null);
                      setStartMs(null);
                    }}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      vehicleCategory === cat
                        ? "border-accent-400 bg-ink-800 text-white"
                        : "border-ink-700 text-ink-300 hover:border-ink-500"
                    }`}
                  >
                    {VEHICLE_CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Year" value={vehicle.year} onChange={(v) => setVehicle({ ...vehicle, year: v })} placeholder="2021" />
              <Field label="Colour" value={vehicle.colour} onChange={(v) => setVehicle({ ...vehicle, colour: v })} placeholder="Black" />
              <Field label="Make *" value={vehicle.make} onChange={(v) => setVehicle({ ...vehicle, make: v })} placeholder="Honda" />
              <Field label="Model *" value={vehicle.model} onChange={(v) => setVehicle({ ...vehicle, model: v })} placeholder="Civic" />
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
            {eligibleAddons.length === 0 && (
              <p className="text-ink-400">No add-ons available for this service.</p>
            )}
            {eligibleAddons.map((a) => {
              const checked = selectedAddons.includes(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    setSelectedAddons(
                      checked ? selectedAddons.filter((x) => x !== a.id) : [...selectedAddons, a.id],
                    );
                    setSlots(null);
                    setStartMs(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl border p-4 text-left ${
                    checked ? "border-accent-400 bg-ink-800" : "border-ink-700 bg-ink-900/50 hover:border-ink-500"
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
            <div>
              <label className="mb-1 block text-sm text-ink-300">Choose a date</label>
              <input
                type="date"
                min={minDate}
                max={maxDate}
                value={dateISO}
                onChange={(e) => {
                  setDateISO(e.target.value);
                  void loadSlots(e.target.value);
                }}
                className="rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-white [color-scheme:dark]"
              />
            </div>
            {slotsLoading && <p className="text-ink-400">Checking availability…</p>}
            {slotsError && <p className="text-red-400">{slotsError}</p>}
            {slots && slots.length === 0 && (
              <p className="text-ink-400">
                No openings that day — please try another date.
              </p>
            )}
            {slots && slots.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s.startMs}
                    onClick={() => setStartMs(s.startMs)}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      startMs === s.startMs
                        ? "border-accent-400 bg-accent-400 font-semibold text-ink-950"
                        : "border-ink-700 text-ink-200 hover:border-ink-500"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <StepNav onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!startMs} />
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name *" value={contact.firstName} onChange={(v) => setContact({ ...contact, firstName: v })} />
              <Field label="Last name *" value={contact.lastName} onChange={(v) => setContact({ ...contact, lastName: v })} />
              <Field label="Email" type="email" value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} />
              <Field label="Phone" type="tel" value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-ink-300">Anything we should know?</label>
              <textarea
                value={contact.notes}
                onChange={(e) => setContact({ ...contact, notes: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-white"
                placeholder="Pet hair, stains, areas of focus…"
              />
            </div>
            <label className="flex items-start gap-3 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={policiesAccepted}
                onChange={(e) => setPoliciesAccepted(e.target.checked)}
                className="mt-1"
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
            {result && !result.ok && <p className="text-red-400">{result.error}</p>}
            <div className="flex gap-3">
              <button onClick={() => setStep(3)} className="rounded-lg border border-ink-600 px-5 py-3 text-sm text-ink-200">
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
                className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
              >
                {submitting ? "Booking…" : "Confirm Booking"}
              </button>
            </div>
            <p className="text-xs text-ink-500">
              Provide at least an email or phone number so we can confirm your appointment.
            </p>
          </div>
        )}
      </div>

      {/* Summary sidebar */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-2xl border border-ink-700 bg-ink-900/60 p-6">
          <h3 className="font-semibold text-white">Your booking</h3>
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
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm text-ink-300">{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-white placeholder:text-ink-600"
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
    <div className="flex gap-3 pt-2">
      <button onClick={onBack} className="rounded-lg border border-ink-600 px-5 py-3 text-sm text-ink-200">
        Back
      </button>
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
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
