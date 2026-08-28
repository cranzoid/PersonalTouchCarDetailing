"use client";

import { useEffect, useId, useRef, useState } from "react";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";

/**
 * The vehicle form, as a modal, wherever a vehicle is missing or wrong.
 *
 * Every screen that prices work needs a vehicle, and until now the only place
 * to enter one was the customer record — so "this SUV is booked in as a sedan"
 * meant leaving the invoice or the appointment, fixing it elsewhere, and coming
 * back. This component is deliberately dumb about persistence: the caller owns
 * the server action, because "add a vehicle to this customer" and "correct the
 * vehicle on this appointment" are different writes with different permissions.
 */

export type VehicleFormValues = {
  year: string;
  make: string;
  model: string;
  trim: string;
  category: VehicleCategory;
  colour: string;
  licencePlate: string;
};

export const emptyVehicleForm: VehicleFormValues = {
  year: "",
  make: "",
  model: "",
  trim: "",
  category: "sedan",
  colour: "",
  licencePlate: "",
};

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const labelClass = "mb-1 block text-xs text-ink-400";

export function VehicleDialog({
  title,
  description,
  initial = emptyVehicleForm,
  submitLabel,
  busy,
  error,
  onCancel,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  initial?: VehicleFormValues;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: VehicleFormValues) => void;
  /** Extra content between the fields and the buttons — e.g. a pricing warning. */
  children?: (values: VehicleFormValues) => React.ReactNode;
}) {
  const titleId = useId();
  const [form, setForm] = useState<VehicleFormValues>(initial);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // Escape closes, the way every other dialog on the machine does.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function set<K extends keyof VehicleFormValues>(key: K, value: VehicleFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const canSubmit = form.make.trim().length > 0 && form.model.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
      onMouseDown={(event) => {
        // Only a click that both starts and ends on the backdrop dismisses —
        // a drag that finishes outside a text field must not throw the form away.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="font-semibold text-white">{title}</h2>
            {description && <p className="mt-1 text-xs text-ink-400">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:border-ink-500"
          >
            Cancel
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={labelClass}>Make</span>
            <input
              ref={firstFieldRef}
              className={inputClass}
              value={form.make}
              onChange={(event) => set("make", event.target.value)}
              placeholder="Toyota"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Model</span>
            <input
              className={inputClass}
              value={form.model}
              onChange={(event) => set("model", event.target.value)}
              placeholder="RAV4"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Year</span>
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.year}
              onChange={(event) => set("year", event.target.value)}
              placeholder="2021"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Size category (drives package pricing)</span>
            <select
              className={inputClass}
              value={form.category}
              onChange={(event) => set("category", event.target.value as VehicleCategory)}
            >
              {VEHICLE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {VEHICLE_CATEGORY_LABELS[category] ?? category}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Trim (optional)</span>
            <input
              className={inputClass}
              value={form.trim}
              onChange={(event) => set("trim", event.target.value)}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Colour (optional)</span>
            <input
              className={inputClass}
              value={form.colour}
              onChange={(event) => set("colour", event.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClass}>Licence plate (optional)</span>
            <input
              className={inputClass}
              value={form.licencePlate}
              onChange={(event) => set("licencePlate", event.target.value)}
            />
          </label>
        </div>

        {children?.(form)}

        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSubmit(form)}
            disabled={busy || !canSubmit}
            className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {busy ? "Saving…" : submitLabel}
          </button>
          {!canSubmit && <span className="text-xs text-ink-500">Make and model are required.</span>}
        </div>
      </div>
    </div>
  );
}

/** Shapes dialog values for the server actions, which take real types. */
export function vehiclePayload(values: VehicleFormValues) {
  const year = Number(values.year);
  return {
    year: values.year.trim() && Number.isFinite(year) ? year : undefined,
    make: values.make.trim(),
    model: values.model.trim(),
    trim: values.trim.trim() || undefined,
    category: values.category,
    colour: values.colour.trim() || undefined,
    licencePlate: values.licencePlate.trim() || undefined,
  };
}

/** The one-line label the pickers show for a vehicle. */
export function vehicleLabel(values: {
  year?: number | null;
  make: string;
  model: string;
  trim?: string | null;
  licencePlate?: string | null;
}): string {
  return [values.year, values.make, values.model, values.trim, values.licencePlate && `(${values.licencePlate})`]
    .filter(Boolean)
    .join(" ");
}
