"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { bookMemberVisitAction, memberSlotsAction } from "../actions";

export type BookableVehicle = {
  id: string;
  label: string;
  memberPlan: string | null;
  discountPercent: number;
  benefits: { key: string; label: string; available: boolean }[];
  benefitsUntil: string | null;
  passWashesLeft: number;
  /** First day a pass wash can be booked, YYYY-MM-DD. */
  passFromISO: string | null;
};

type Use = "member" | "pass" | "package";
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400";
const box = (on: boolean) =>
  `flex min-h-11 items-center gap-3 rounded-xl border px-4 py-2 text-sm ${on ? "border-accent-400 bg-accent-400/10 text-white" : "border-ink-700 text-ink-200"}`;

export function MemberBookForm({
  vehicles,
  packages,
  initialVehicleId,
  initialUse,
  minDateISO,
  maxDateISO,
  taxLabel,
}: {
  vehicles: BookableVehicle[];
  packages: { id: string; name: string; addons: { id: string; name: string }[] }[];
  initialVehicleId?: string;
  initialUse?: Use;
  minDateISO: string;
  maxDateISO: string;
  taxLabel: string;
}) {
  const router = useRouter();
  const [vehicleId, setVehicleId] = useState(vehicles.find((v) => v.id === initialVehicleId)?.id ?? vehicles[0].id);
  const vehicle = vehicles.find((v) => v.id === vehicleId)!;
  const options = useMemo(() => {
    const list: { use: Use; label: string; hint?: string }[] = [];
    if (vehicle.memberPlan && vehicle.benefits.some((b) => b.available)) {
      list.push({ use: "member", label: `My ${vehicle.memberPlan} visit`, hint: vehicle.benefitsUntil ? `Use by ${vehicle.benefitsUntil}` : undefined });
    }
    if (vehicle.passWashesLeft > 0) list.push({ use: "pass", label: `Winter Pass wash (${vehicle.passWashesLeft} left)` });
    list.push({
      use: "package",
      label: vehicle.discountPercent > 0 ? `A detailing package — ${vehicle.discountPercent}% member discount` : "A detailing package",
    });
    return list;
  }, [vehicle]);
  const [use, setUse] = useState<Use>(initialUse && options.some((o) => o.use === initialUse) ? initialUse : options[0].use);
  const [benefits, setBenefits] = useState<string[]>(() => vehicle.benefits.filter((b) => b.available).map((b) => b.key));
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<{ startMs: number; label: string }[] | null>(null);
  const [totalLabel, setTotalLabel] = useState<string | null>(null);
  const [discountLabel, setDiscountLabel] = useState<string | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);

  // Changing the car resets what can be booked on it.
  useEffect(() => {
    if (!options.some((o) => o.use === use)) setUse(options[0].use);
    setBenefits(vehicle.benefits.filter((b) => b.available).map((b) => b.key));
  }, [vehicleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const request = {
    vehicleId,
    use,
    benefits: use === "member" ? benefits : undefined,
    packageServiceId: use === "package" ? packageId : undefined,
    addonIds: use === "package" ? addonIds : undefined,
  };
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    setSlots(null);
    setStartMs(null);
    setTotalLabel(null);
    if (!dateISO) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void memberSlotsAction({ ...request, dateISO }).then((result) => {
      if (cancelled) return;
      setBusy(false);
      if (!result.ok) return setError(result.error);
      setSlots(result.slots);
      setTotalLabel(result.totalLabel);
      setDiscountLabel(result.discountLabel);
    });
    return () => {
      cancelled = true;
    };
  }, [dateISO, requestKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function book() {
    if (!startMs) return;
    setBusy(true);
    setError(null);
    const result = await bookMemberVisitAction({ ...request, dateISO, startMs });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    const slot = slots?.find((s) => s.startMs === startMs);
    const dayLabel = new Date(`${dateISO}T12:00:00Z`).toLocaleDateString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    setBooked(
      result.depositRequired
        ? `Your time on ${dayLabel} at ${slot?.label} is held — this package needs a deposit, and we've sent you a secure link to pay it`
        : `You're booked for ${dayLabel} at ${slot?.label} — a confirmation is on its way`,
    );
    router.refresh();
  }

  if (booked) {
    return (
      <div role="status" className="rounded-2xl border border-emerald-500/30 bg-emerald-950/25 p-6 text-emerald-200">
        <p className="text-lg font-semibold">{booked}</p>
        <a href="/account" className={`mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent-400 px-5 text-sm font-semibold text-ink-950 ${focusRing}`}>
          Back to my account
        </a>
      </div>
    );
  }

  const minDate = use === "pass" && vehicle.passFromISO && vehicle.passFromISO > minDateISO ? vehicle.passFromISO : minDateISO;
  const currentPackage = packages.find((p) => p.id === packageId);

  return (
    <div className="space-y-6">
      {vehicles.length > 1 && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-white">Car</legend>
          <div className="space-y-2">
            {vehicles.map((v) => (
              <label key={v.id} className={box(v.id === vehicleId)}>
                <input type="radio" name="vehicle" className="h-4 w-4 accent-[#e0a93b]" checked={v.id === vehicleId} onChange={() => setVehicleId(v.id)} />
                {v.label}
                {v.memberPlan && <span className="ml-auto text-xs text-accent-300">{v.memberPlan}</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-white">What would you like?</legend>
        <div className="space-y-2">
          {options.map((option) => (
            <label key={option.use} className={box(option.use === use)}>
              <input type="radio" name="use" className="h-4 w-4 accent-[#e0a93b]" checked={option.use === use} onChange={() => setUse(option.use)} />
              <span>
                {option.label}
                {option.hint && <span className="block text-xs text-ink-400">{option.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {use === "member" && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-white">Included this month</legend>
          <div className="space-y-2">
            {vehicle.benefits.map((benefit) => (
              <label key={benefit.key} className={box(benefits.includes(benefit.key))}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#e0a93b]"
                  disabled={!benefit.available}
                  checked={benefits.includes(benefit.key)}
                  onChange={(e) => setBenefits((cur) => (e.target.checked ? [...cur, benefit.key] : cur.filter((k) => k !== benefit.key)))}
                />
                {benefit.label}
                {!benefit.available && <span className="ml-auto text-xs text-ink-500">Used this month</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {use === "package" && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold text-white">Package</legend>
          <select
            className={`min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950 px-3 text-base text-white ${focusRing}`}
            value={packageId}
            onChange={(e) => {
              setPackageId(e.target.value);
              setAddonIds([]);
            }}
          >
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {currentPackage && currentPackage.addons.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-ink-400">Add-ons (optional)</p>
              {currentPackage.addons.map((addon) => (
                <label key={addon.id} className={box(addonIds.includes(addon.id))}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#e0a93b]"
                    checked={addonIds.includes(addon.id)}
                    onChange={(e) => setAddonIds((cur) => (e.target.checked ? [...cur, addon.id] : cur.filter((id) => id !== addon.id)))}
                  />
                  {addon.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <label className="block text-sm font-semibold text-white">
        Day
        <input
          type="date"
          className={`mt-2 min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950 px-3 text-base text-white ${focusRing}`}
          min={minDate}
          max={maxDateISO}
          value={dateISO}
          onChange={(e) => setDateISO(e.target.value)}
        />
      </label>

      {busy && !slots && <p className="text-sm text-ink-400">Checking times…</p>}
      {slots && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-white">Time</legend>
          {slots.length === 0 ? (
            <p className="text-sm text-ink-400">No times left that day — try another.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((slot) => (
                <button
                  key={slot.startMs}
                  type="button"
                  onClick={() => setStartMs(slot.startMs)}
                  className={`min-h-11 rounded-xl border text-sm ${focusRing} ${slot.startMs === startMs ? "border-accent-400 bg-accent-400 font-semibold text-ink-950" : "border-ink-600 text-ink-100 hover:bg-ink-800"}`}
                >
                  {slot.label}
                </button>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {totalLabel && (
        <p className="rounded-xl border border-ink-700 bg-ink-950/40 p-4 text-sm text-ink-200">
          Estimated total: <strong className="text-lg text-accent-300">{totalLabel}</strong> incl. {taxLabel}
          {discountLabel && <span className="block text-xs text-emerald-300">{discountLabel} applied</span>}
        </p>
      )}

      <button
        type="button"
        disabled={!startMs || busy}
        onClick={() => void book()}
        className={`min-h-11 w-full rounded-xl bg-accent-400 px-4 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40 ${focusRing}`}
      >
        {busy && startMs ? "Booking…" : "Book this time"}
      </button>
      {error && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
