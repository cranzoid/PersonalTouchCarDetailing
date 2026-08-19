"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { removeCustomerVehicleAction } from "../actions";

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

export function VehicleList({
  customerId,
  vehicles,
  title = "Vehicles",
  emptyText = "No vehicles on file.",
  columns = "sm:grid-cols-2",
}: {
  customerId: string;
  vehicles: VehicleListItem[];
  title?: string;
  emptyText?: string;
  columns?: string;
}) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const visible = vehicles.filter((vehicle) => !hiddenIds.includes(vehicle.id));

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
          const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
          return (
            <article key={vehicle.id} className="rounded-xl border border-ink-800 p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-white">{label}</p>
                  <p className="mt-1 capitalize text-ink-400">
                    {vehicle.category.replaceAll("_", " ")}
                    {vehicle.colour ? ` · ${vehicle.colour}` : ""}
                  </p>
                  {vehicle.licencePlate && <p className="mt-1 font-mono text-xs text-ink-500">{vehicle.licencePlate}</p>}
                  {vehicle.conditionNotes && <p className="mt-2 text-xs text-ink-500">{vehicle.conditionNotes}</p>}
                </div>
                {!confirming && (
                  <button type="button" onClick={() => { setConfirmId(vehicle.id); setError(null); }} className="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
                    Remove
                  </button>
                )}
              </div>
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
