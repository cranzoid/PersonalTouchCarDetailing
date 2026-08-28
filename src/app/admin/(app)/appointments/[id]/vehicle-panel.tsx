"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  VehicleDialog,
  emptyVehicleForm,
  vehicleLabel,
  vehiclePayload,
  type VehicleFormValues,
} from "@/components/vehicle-dialog";
import { formatCents } from "@/lib/money";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { addCustomerVehicleAction } from "../../customers/actions";
import { updateAppointmentVehicleAction } from "../actions";

export type AppointmentVehicle = {
  id: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  category: string;
  colour: string | null;
  licencePlate: string | null;
};

function toFormValues(vehicle: AppointmentVehicle): VehicleFormValues {
  return {
    year: vehicle.year ? String(vehicle.year) : "",
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim ?? "",
    category: vehicle.category as VehicleCategory,
    colour: vehicle.colour ?? "",
    licencePlate: vehicle.licencePlate ?? "",
  };
}

function label(category: string): string {
  return VEHICLE_CATEGORY_LABELS[category as VehicleCategory] ?? category;
}

/**
 * "Change vehicle" on a booking.
 *
 * The online form asks the customer for their own vehicle size and they get it
 * wrong, so a large SUV arrives booked — and priced — as a sedan. This is where
 * the shop fixes that: correct the car's details, or point the booking at a
 * different car on the customer's record, and the packages re-price for the new
 * size. Which packages were chosen is untouched; that is "Change packages".
 */
export function VehiclePanel({
  appointmentId,
  customerId,
  vehicle,
  otherVehicles,
  currency,
  canReprice,
}: {
  appointmentId: string;
  customerId: string;
  vehicle: AppointmentVehicle | null;
  /** The customer's other cars, offered as a swap. */
  otherVehicles: AppointmentVehicle[];
  currency: string;
  /** False once the sale has settled — the panel says prices will not move. */
  canReprice: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"closed" | "edit" | "add">("closed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlapWarnings, setOverlapWarnings] = useState<string[] | null>(null);
  const [pending, setPending] = useState<VehicleFormValues | null>(null);
  const [swapTarget, setSwapTarget] = useState<string | null>(null);
  const [done, setDone] = useState<{ repriced: boolean; totalCents: number | null; warnings: string[] } | null>(null);

  async function save(values: VehicleFormValues, confirmOverlap: boolean) {
    if (!vehicle) return;
    setBusy(true);
    setError(null);
    setOverlapWarnings(null);
    const result = await updateAppointmentVehicleAction({
      appointmentId,
      vehicleId: vehicle.id,
      details: vehiclePayload(values),
      confirmOverlap,
    });
    setBusy(false);
    if (!result.ok) {
      if ("needsOverlapConfirm" in result) {
        // Held so the second press submits the same edit rather than asking
        // the owner to retype it.
        setPending(values);
        setOverlapWarnings(result.warnings);
        return;
      }
      return setError(result.error);
    }
    setMode("closed");
    setPending(null);
    setDone({ repriced: result.repriced, totalCents: result.totalCents, warnings: result.warnings });
    router.refresh();
  }

  /** Swaps the booking onto another car already on the customer's record. */
  async function swapTo(vehicleId: string, confirmOverlap: boolean) {
    setBusy(true);
    setError(null);
    setOverlapWarnings(null);
    const result = await updateAppointmentVehicleAction({ appointmentId, vehicleId, confirmOverlap });
    setBusy(false);
    if (!result.ok) {
      if ("needsOverlapConfirm" in result) {
        setPending(null);
        setOverlapWarnings(result.warnings);
        setSwapTarget(vehicleId);
        return;
      }
      return setError(result.error);
    }
    setSwapTarget(null);
    setDone({ repriced: result.repriced, totalCents: result.totalCents, warnings: result.warnings });
    router.refresh();
  }

  /** Adds a car this customer did not have on file, and books onto it. */
  async function addAndUse(values: VehicleFormValues) {
    setBusy(true);
    setError(null);
    const payload = vehiclePayload(values);
    const added = await addCustomerVehicleAction({ customerId, ...payload });
    if (!added.ok) {
      setBusy(false);
      return setError(added.error);
    }
    setBusy(false);
    setMode("closed");
    await swapTo(added.vehicleId, false);
  }

  return (
    <section className="mt-4 rounded-xl border border-ink-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <p className="font-medium text-white">
            {vehicle ? vehicleLabel(vehicle) : "Missing vehicle record"}
          </p>
          {vehicle && (
            <p className="mt-0.5 text-xs text-ink-400">
              Pricing size: <span className="text-ink-200">{label(vehicle.category)}</span>
              {vehicle.colour ? ` · ${vehicle.colour}` : ""}
            </p>
          )}
        </div>
        {vehicle && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setDone(null);
                setMode("edit");
              }}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:border-ink-500"
            >
              Change vehicle
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setDone(null);
                setMode("add");
              }}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:border-ink-500"
            >
              + Add vehicle
            </button>
          </div>
        )}
      </div>

      {otherVehicles.length > 0 && vehicle && (
        <div className="mt-3">
          <p className="text-xs text-ink-500">Or switch to another car on this customer&rsquo;s record:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {otherVehicles.map((other) => (
              <button
                key={other.id}
                type="button"
                disabled={busy}
                onClick={() => void swapTo(other.id, false)}
                className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 hover:border-accent-500/60 disabled:opacity-40"
              >
                {vehicleLabel(other)} · {label(other.category)}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-ink-500">
        {canReprice
          ? "Changing the size re-prices the packages already on this booking for the new size. Which packages were chosen does not change — use “Change packages” for that."
          : "This sale has settled, so the vehicle can be corrected but the prices on this booking will be left as they are."}
      </p>

      {/* The dialog shows its own copy while it is open. */}
      {error && mode === "closed" && <p className="mt-3 text-sm text-red-300">{error}</p>}

      {overlapWarnings && (
        <div className="mt-3 rounded-lg border border-amber-800/60 p-3">
          {overlapWarnings.map((warning) => (
            <p key={warning} className="text-sm text-amber-300">{warning}</p>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (pending) return void save(pending, true);
              if (swapTarget) return void swapTo(swapTarget, true);
            }}
            className="mt-2 rounded-lg border border-amber-500 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-40"
          >
            Change anyway
          </button>
        </div>
      )}

      {done && (
        <div className="mt-3 rounded-lg border border-emerald-800/60 p-3">
          <p className="text-sm text-emerald-300">
            Vehicle updated.
            {done.repriced && done.totalCents !== null
              ? ` Packages re-priced for the new size — new total ${formatCents(done.totalCents, currency)}.`
              : ""}
          </p>
          {done.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-sm text-amber-300">{warning}</p>
          ))}
        </div>
      )}

      {mode === "edit" && vehicle && (
        <VehicleDialog
          title="Change vehicle"
          description="Correct what is on file for this car. Changing the size re-prices this booking."
          initial={toFormValues(vehicle)}
          submitLabel="Save vehicle"
          busy={busy}
          error={error}
          onCancel={() => setMode("closed")}
          onSubmit={(values) => void save(values, false)}
        >
          {(values) =>
            values.category !== vehicle.category ? (
              <p className="mt-4 rounded-lg border border-amber-800/60 p-3 text-sm text-amber-300">
                {canReprice
                  ? `Size changes from ${label(vehicle.category)} to ${label(values.category)} — the packages on this booking will be re-priced.`
                  : `Size changes from ${label(vehicle.category)} to ${label(values.category)}, but this sale has settled, so the prices will not move.`}
              </p>
            ) : null
          }
        </VehicleDialog>
      )}

      {mode === "add" && (
        <VehicleDialog
          title="Add a vehicle"
          description="Added to this customer's record, and this booking moves onto it."
          initial={emptyVehicleForm}
          submitLabel="Add and use for this booking"
          busy={busy}
          error={error}
          onCancel={() => setMode("closed")}
          onSubmit={(values) => void addAndUse(values)}
        />
      )}
    </section>
  );
}
