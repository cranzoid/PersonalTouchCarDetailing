"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { removeCustomerVehicleAction, updateCustomerVehicleAction } from "../actions";
import { sellWinterPassAction } from "../../memberships/actions";

export type VehicleListItem = {
  id: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  category: string;
  colour: string | null;
  licencePlate: string | null;
  conditionNotes: string | null;
};

const inputClass = "rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-ink-600";

export function VehicleList({
  customerId,
  vehicles,
  title = "Vehicles",
  emptyText = "No vehicles on file.",
  columns = "sm:grid-cols-2",
  canSellPass = false,
}: {
  customerId: string;
  vehicles: VehicleListItem[];
  title?: string;
  emptyText?: string;
  columns?: string;
  /** Shows "Sell Winter Pass" on each car (staff who can record payments). */
  canSellPass?: boolean;
}) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const visible = vehicles.filter((vehicle) => !hiddenIds.includes(vehicle.id));

  async function sellPass(vehicle: VehicleListItem) {
    setBusyId(vehicle.id);
    setError(null);
    const result = await sellWinterPassAction({ customerId, vehicleId: vehicle.id });
    setBusyId(null);
    if (!result.ok) return setError(result.error);
    if ("invoiceId" in result && result.invoiceId) router.push(`/admin/invoices/${result.invoiceId}`);
  }

  async function save(vehicle: VehicleListItem, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId(vehicle.id);
    setError(null);
    const form = new FormData(event.currentTarget);
    const year = String(form.get("year") ?? "").trim();
    const result = await updateCustomerVehicleAction({
      customerId,
      vehicleId: vehicle.id,
      year: year ? Number(year) : null,
      make: form.get("make"),
      model: form.get("model"),
      trim: form.get("trim"),
      category: form.get("category"),
      colour: form.get("colour"),
      licencePlate: form.get("licencePlate"),
      conditionNotes: form.get("conditionNotes"),
    });
    setBusyId(null);
    if (!result.ok) return setError(result.error);
    setEditId(null);
    router.refresh();
  }

  async function remove(vehicle: VehicleListItem) {
    setBusyId(vehicle.id);
    setError(null);
    const result = await removeCustomerVehicleAction({ customerId, vehicleId: vehicle.id, confirmation: "REMOVE" });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmId(null);
    setHiddenIds((current) => [...current, vehicle.id]);
    router.refresh();
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{title} ({visible.length})</h2>
        <p className="text-xs text-ink-500">Only unused vehicles can be removed.</p>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className={`mt-3 grid gap-3 ${columns}`}>
        {visible.map((vehicle) => {
          const confirming = confirmId === vehicle.id;
          const editing = editId === vehicle.id;
          const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
          return (
            <article key={vehicle.id} className={`rounded-xl border border-ink-800 p-4 text-sm ${editing ? "col-span-full" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-white">{label}</p>
                  <p className="mt-1 text-ink-400">
                    {VEHICLE_CATEGORY_LABELS[vehicle.category as VehicleCategory] ?? vehicle.category.replaceAll("_", " ")}
                    {vehicle.colour ? ` · ${vehicle.colour}` : ""}
                  </p>
                  {vehicle.licencePlate && <p className="mt-1 font-mono text-xs text-ink-500">{vehicle.licencePlate}</p>}
                  {vehicle.conditionNotes && <p className="mt-2 text-xs text-ink-500">{vehicle.conditionNotes}</p>}
                </div>
                {!confirming && !editing && (
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => { setEditId(vehicle.id); setConfirmId(null); setError(null); }} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:bg-ink-800">
                      Edit
                    </button>
                    <button type="button" onClick={() => { setConfirmId(vehicle.id); setEditId(null); setError(null); }} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {editing && (
                <form onSubmit={(event) => void save(vehicle, event)} className="mt-4 grid gap-2 border-t border-ink-800 pt-4 sm:grid-cols-2">
                  <label className="text-xs text-ink-400">Year
                    <input name="year" type="number" min="1900" max={new Date().getFullYear() + 2} defaultValue={vehicle.year ?? ""} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400">Size category
                    <select name="category" defaultValue={vehicle.category} className={`${inputClass} mt-1 w-full`}>
                      {VEHICLE_CATEGORIES.map((category) => <option key={category} value={category}>{VEHICLE_CATEGORY_LABELS[category]}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-ink-400">Make
                    <input name="make" required maxLength={60} defaultValue={vehicle.make} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400">Model
                    <input name="model" required maxLength={60} defaultValue={vehicle.model} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400">Trim
                    <input name="trim" maxLength={60} defaultValue={vehicle.trim ?? ""} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400">Colour
                    <input name="colour" maxLength={60} defaultValue={vehicle.colour ?? ""} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400 sm:col-span-2">Licence plate
                    <input name="licencePlate" maxLength={30} defaultValue={vehicle.licencePlate ?? ""} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <label className="text-xs text-ink-400 sm:col-span-2">Condition notes
                    <textarea name="conditionNotes" rows={2} maxLength={1000} defaultValue={vehicle.conditionNotes ?? ""} className={`${inputClass} mt-1 w-full`} />
                  </label>
                  <p className="text-xs text-ink-500 sm:col-span-2">
                    Changing the size category changes prices for future bookings and invoices only. Anything already booked, invoiced or on a membership keeps its price.
                  </p>
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <button type="submit" disabled={busyId === vehicle.id} className="rounded-lg bg-accent-400 px-3 py-1.5 text-xs font-semibold text-ink-950 disabled:opacity-50">
                      {busyId === vehicle.id ? "Saving…" : "Save vehicle"}
                    </button>
                    <button type="button" onClick={() => setEditId(null)} disabled={busyId === vehicle.id} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-200 disabled:opacity-50">Cancel</button>
                  </div>
                </form>
              )}
              {canSellPass && !confirming && !editing && (
                <button
                  type="button"
                  onClick={() => void sellPass(vehicle)}
                  disabled={busyId === vehicle.id}
                  className="mt-3 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:bg-ink-800 disabled:opacity-50"
                >
                  {busyId === vehicle.id ? "Creating…" : "Sell Winter Pass"}
                </button>
              )}
              {confirming && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-semibold text-red-800">Remove {label}?</p>
                  <p className="mt-1 text-xs text-red-700">This cannot be undone. Vehicles used in business history are automatically protected.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void remove(vehicle)} disabled={busyId === vehicle.id} className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                      {busyId === vehicle.id ? "Removing…" : "Yes, remove vehicle"}
                    </button>
                    <button type="button" onClick={() => setConfirmId(null)} disabled={busyId === vehicle.id} className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50">Cancel</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {visible.length === 0 && <p className="text-sm text-ink-500">{emptyText}</p>}
      </div>
    </section>
  );
}
