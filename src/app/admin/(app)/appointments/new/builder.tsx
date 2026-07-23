"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { createManualAppointmentAction, getManualAppointmentSlotsAction } from "../actions";

type CustomerOption = { id: string; label: string; contact: string };
type VehicleOption = { id: string; customerId: string; label: string; category: string };
type ServiceOption = { id: string; name: string; categoryName: string; basePriceCents: number; addonIds: string[] };
type AddonOption = { id: string; name: string; priceCents: number };

const inputClass = "w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white";

export function NewAppointmentBuilder({
  customers,
  vehicles,
  services,
  addons,
  maxBookingWindowDays,
}: {
  customers: CustomerOption[];
  vehicles: VehicleOption[];
  services: ServiceOption[];
  addons: AddonOption[];
  maxBookingWindowDays: number;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<Array<{ startMs: number; label: string }> | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [totalCents, setTotalCents] = useState<number | null>(null);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customerVehicles = useMemo(() => vehicles.filter((vehicle) => vehicle.customerId === customerId), [vehicles, customerId]);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId);
  const eligibleAddonIds = useMemo(() => new Set(services.filter((service) => serviceIds.includes(service.id)).flatMap((service) => service.addonIds)), [services, serviceIds]);
  const eligibleAddons = addons.filter((addon) => eligibleAddonIds.has(addon.id));
  const minDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + maxBookingWindowDays * 86_400_000).toISOString().slice(0, 10);

  function resetAvailability() {
    setSlots(null);
    setStartMs(null);
    setTotalCents(null);
    setDurationMin(null);
  }

  function toggleService(id: string) {
    const next = serviceIds.includes(id) ? serviceIds.filter((value) => value !== id) : [...serviceIds, id];
    const nextAllowed = new Set(services.filter((service) => next.includes(service.id)).flatMap((service) => service.addonIds));
    setServiceIds(next);
    setAddonIds((current) => current.filter((addonId) => nextAllowed.has(addonId)));
    resetAvailability();
  }

  async function loadSlots() {
    setBusy(true);
    setError(null);
    const result = await getManualAppointmentSlotsAction({ customerId, vehicleId, serviceIds, addonIds, dateISO });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSlots(result.slots);
    setStartMs(null);
    setTotalCents(result.totalCents ?? null);
    setDurationMin(result.durationMin);
  }

  async function createAppointment() {
    if (!startMs) return;
    setBusy(true);
    setError(null);
    const result = await createManualAppointmentAction({
      customerId,
      vehicleId,
      serviceIds,
      addonIds,
      dateISO,
      startMs,
      customerNotes: notes || undefined,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/appointments/${result.appointmentId}`);
    router.refresh();
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">1. Customer and vehicle</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-ink-300">Customer
              <select value={customerId} onChange={(event) => { setCustomerId(event.target.value); setVehicleId(""); resetAvailability(); }} className={`${inputClass} mt-1`}>
                <option value="">Select customer…</option>
                {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.label} · {customer.contact}</option>)}
              </select>
            </label>
            <label className="text-sm text-ink-300">Vehicle
              <select value={vehicleId} disabled={!customerId} onChange={(event) => { setVehicleId(event.target.value); resetAvailability(); }} className={`${inputClass} mt-1 disabled:opacity-50`}>
                <option value="">Select vehicle…</option>
                {customerVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}</option>)}
              </select>
            </label>
          </div>
          {customerId && customerVehicles.length === 0 && <p className="mt-3 text-sm text-amber-300">This customer has no vehicle. Add one from their customer record first.</p>}
          {selectedVehicle && <p className="mt-3 text-sm text-ink-400">Pricing category: <span className="text-white">{VEHICLE_CATEGORY_LABELS[selectedVehicle.category as VehicleCategory] ?? selectedVehicle.category}</span></p>}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">2. Services and add-ons</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {services.map((service) => <label key={service.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-800 p-3 hover:border-accent-500/50"><input type="checkbox" checked={serviceIds.includes(service.id)} onChange={() => toggleService(service.id)} className="mt-1 accent-accent-400" /><span><span className="block text-xs uppercase tracking-wide text-ink-500">{service.categoryName}</span><span className="block text-sm font-medium text-white">{service.name}</span><span className="block text-xs text-ink-400">From {formatCents(service.basePriceCents)}</span></span></label>)}
          </div>
          {eligibleAddons.length > 0 && <div className="mt-5"><p className="text-sm font-medium text-ink-300">Available add-ons</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{eligibleAddons.map((addon) => <label key={addon.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-800 p-3 text-sm text-white"><input type="checkbox" checked={addonIds.includes(addon.id)} onChange={() => { setAddonIds(addonIds.includes(addon.id) ? addonIds.filter((id) => id !== addon.id) : [...addonIds, addon.id]); resetAvailability(); }} className="accent-accent-400" />{addon.name} <span className="ml-auto text-ink-400">+{formatCents(addon.priceCents)}</span></label>)}</div></div>}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="font-semibold text-white">3. Date and real availability</h2>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm text-ink-300">Date<input type="date" min={minDate} max={maxDate} value={dateISO} onChange={(event) => { setDateISO(event.target.value); resetAvailability(); }} className={`${inputClass} mt-1`} /></label>
            <button onClick={() => void loadSlots()} disabled={busy || !customerId || !vehicleId || serviceIds.length === 0 || !dateISO} className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Checking…" : "Check availability"}</button>
          </div>
          {slots && slots.length === 0 && <p className="mt-4 text-sm text-ink-400">No openings on this date.</p>}
          {slots && slots.length > 0 && <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">{slots.map((slot) => <button key={slot.startMs} onClick={() => setStartMs(slot.startMs)} className={`rounded-lg border px-3 py-2 text-sm ${startMs === slot.startMs ? "border-accent-400 bg-accent-400 font-semibold text-ink-950" : "border-ink-700 text-ink-200"}`}>{slot.label}</button>)}</div>}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <label className="text-sm text-ink-300">Customer/service notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} className={`${inputClass} mt-1`} /></label>
        </section>
      </div>

      <aside className="rounded-xl border border-ink-800 p-5 lg:sticky lg:top-24 lg:self-start">
        <h2 className="font-semibold text-white">Staff booking</h2>
        <p className="mt-2 text-sm text-ink-400">Prices, duration and capacity are revalidated on the server when saved.</p>
        {totalCents !== null && <p className="mt-4 text-lg font-semibold text-accent-300">{formatCents(totalCents)}</p>}
        {durationMin !== null && <p className="text-sm text-ink-400">{durationMin} min service time, plus buffers</p>}
        <p className="mt-4 text-xs text-ink-500">Website policy acceptance is intentionally not recorded for staff-created bookings.</p>
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        <button onClick={() => void createAppointment()} disabled={busy || startMs === null} className="mt-5 w-full rounded-lg bg-accent-400 px-4 py-2.5 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Create appointment"}</button>
      </aside>
    </div>
  );
}
