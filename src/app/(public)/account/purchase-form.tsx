"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HelcimCheckoutButton } from "@/components/helcim-checkout";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { confirmAccountPaymentAction, startJoinAction, startWinterPassAction } from "./actions";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400";
const input = `min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950 px-3 py-2 text-base text-white ${focusRing}`;

/**
 * Buying a membership or a Winter Pass from the account: choose the car (both
 * belong to one car), accept the terms, pay in Helcim's form. The server
 * decides the price; this form only says what is being bought for which car.
 */
export function PurchaseForm({
  kind,
  planId,
  vehicles,
  unavailableVehicleIds,
  needsName,
  terms,
  payLabel,
  successMessage,
}: {
  kind: "membership" | "pass";
  planId?: string;
  vehicles: { id: string; label: string }[];
  /** Cars that already hold what is being bought — not selectable. */
  unavailableVehicleIds: string[];
  needsName: boolean;
  terms: string[];
  payLabel: string;
  successMessage: string;
}) {
  const router = useRouter();
  const selectable = vehicles.filter((v) => !unavailableVehicleIds.includes(v.id));
  const [vehicleId, setVehicleId] = useState<string>(selectable[0]?.id ?? "new");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [category, setCategory] = useState<VehicleCategory>("sedan");
  const [plate, setPlate] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [done, setDone] = useState(false);

  const newCar = vehicleId === "new";
  const ready = accepted && (!needsName || firstName.trim()) && (!newCar || (make.trim() && model.trim()));

  function payload() {
    return {
      ...(planId ? { planId } : {}),
      vehicleId: newCar ? undefined : vehicleId,
      newVehicle: newCar
        ? {
            year: year ? Number(year) : undefined,
            make,
            model,
            category,
            licencePlate: plate || undefined,
          }
        : undefined,
      person: needsName ? { firstName, lastName } : undefined,
      termsAccepted: accepted,
    };
  }

  if (done) {
    return (
      <div role="status" className="rounded-2xl border border-emerald-500/30 bg-emerald-950/25 p-6 text-emerald-200">
        <p className="text-lg font-semibold">{successMessage}</p>
        <a href="/account" className={`mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent-400 px-5 text-sm font-semibold text-ink-950 ${focusRing}`}>
          Go to my account
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {needsName && (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-white">Your name</legend>
          <label className="text-sm text-ink-300">
            First name
            <input className={`${input} mt-1`} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
          </label>
          <label className="text-sm text-ink-300">
            Last name
            <input className={`${input} mt-1`} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
          </label>
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-white">Which car is it for?</legend>
        <div className="space-y-2">
          {vehicles.map((vehicle) => {
            const blocked = unavailableVehicleIds.includes(vehicle.id);
            return (
              <label
                key={vehicle.id}
                className={`flex min-h-11 items-center gap-3 rounded-xl border px-4 py-2 text-sm ${
                  blocked ? "border-ink-800 text-ink-500" : vehicleId === vehicle.id ? "border-accent-400 bg-accent-400/10 text-white" : "border-ink-700 text-ink-200"
                }`}
              >
                <input
                  type="radio"
                  name="vehicle"
                  className="h-4 w-4 accent-[#e0a93b]"
                  disabled={blocked}
                  checked={vehicleId === vehicle.id}
                  onChange={() => setVehicleId(vehicle.id)}
                />
                <span>
                  {vehicle.label}
                  {blocked && <span className="block text-xs">{kind === "membership" ? "Already has a membership" : "Already has a pass"}</span>}
                </span>
              </label>
            );
          })}
          <label className={`flex min-h-11 items-center gap-3 rounded-xl border px-4 py-2 text-sm ${newCar ? "border-accent-400 bg-accent-400/10 text-white" : "border-ink-700 text-ink-200"}`}>
            <input type="radio" name="vehicle" className="h-4 w-4 accent-[#e0a93b]" checked={newCar} onChange={() => setVehicleId("new")} />
            A different car
          </label>
        </div>
        {newCar && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-ink-300">
              Year
              <input className={`${input} mt-1`} inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="text-sm text-ink-300">
              Type
              <select className={`${input} mt-1`} value={category} onChange={(e) => setCategory(e.target.value as VehicleCategory)}>
                {VEHICLE_CATEGORIES.filter((c) => c !== "commercial").map((c) => (
                  <option key={c} value={c}>
                    {VEHICLE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ink-300">
              Make
              <input className={`${input} mt-1`} value={make} onChange={(e) => setMake(e.target.value)} placeholder="Toyota" required />
            </label>
            <label className="text-sm text-ink-300">
              Model
              <input className={`${input} mt-1`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="RAV4" required />
            </label>
            <label className="text-sm text-ink-300 sm:col-span-2">
              Licence plate (optional — we&apos;ll confirm it at your first visit)
              <input className={`${input} mt-1 uppercase`} value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={12} />
            </label>
          </div>
        )}
      </fieldset>

      <div className="rounded-2xl border border-ink-700 bg-ink-950/40 p-4">
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-ink-300">
          {terms.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <label className="mt-4 flex items-start gap-3 text-sm text-ink-100">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-[#e0a93b]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            I agree to these terms
            {kind === "membership" ? " and authorize the monthly charge to my card until I cancel" : ""}. See our{" "}
            <a href="/policies/terms#memberships" target="_blank" rel="noreferrer" className="text-accent-300 underline-offset-4 hover:underline">
              terms
            </a>
            .
          </span>
        </label>
      </div>

      <HelcimCheckoutButton
        label={payLabel}
        disabled={!ready}
        start={() => (kind === "membership" ? startJoinAction(payload()) : startWinterPassAction(payload()))}
        confirm={confirmAccountPaymentAction}
        successMessage={successMessage}
        onSuccess={() => {
          setDone(true);
          router.refresh();
        }}
      />
    </div>
  );
}
