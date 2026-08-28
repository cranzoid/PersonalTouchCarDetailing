"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import { createCustomerAction } from "./actions";

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const labelClass = "mb-1 block text-xs text-ink-400";

/**
 * Only same-origin admin paths may be returned to. `next` reaches this
 * component from the query string, so treating it as a URL would make the
 * "add a customer" link an open redirect.
 */
function safeReturnPath(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/admin/")) return null;
  if (next.startsWith("//") || next.includes("\\")) return null;
  return next;
}

/**
 * Walk-in capture. The vehicle is optional but offered inline because an
 * appointment cannot be booked without one — collecting it here saves a trip
 * to the customer record.
 *
 * `defaultOpen` and `next` exist for the screens that send staff here mid-task.
 * The invoice builder's "add the customer first" link used to land on a list
 * with a button on it — one more click, and then a manual walk back to the
 * half-built invoice. It now opens this form directly and returns to where it
 * came from with the new customer already selected.
 */
export function NewCustomerForm({
  defaultOpen = false,
  next,
}: {
  defaultOpen?: boolean;
  next?: string;
}) {
  const router = useRouter();
  const returnPath = safeReturnPath(next);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withVehicle, setWithVehicle] = useState(true);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    preferredContact: "phone" as "email" | "sms" | "phone",
    customerType: "individual" as "individual" | "business",
    companyName: "",
    notes: "",
    marketingConsent: false,
    year: "",
    make: "",
    model: "",
    category: "sedan" as VehicleCategory,
    colour: "",
    licencePlate: "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createCustomerAction({
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email || undefined,
      phone: form.phone || undefined,
      preferredContact: form.preferredContact,
      customerType: form.customerType,
      companyName: form.companyName || undefined,
      notes: form.notes || undefined,
      marketingConsent: form.marketingConsent,
      vehicle:
        withVehicle && form.make.trim() && form.model.trim()
          ? {
              year: form.year ? Number(form.year) : undefined,
              make: form.make,
              model: form.model,
              category: form.category,
              colour: form.colour || undefined,
              licencePlate: form.licencePlate || undefined,
            }
          : undefined,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    if (returnPath) {
      const params = new URLSearchParams({ customerId: result.customerId });
      if (result.vehicleId) params.set("vehicleId", result.vehicleId);
      router.push(`${returnPath}${returnPath.includes("?") ? "&" : "?"}${params}`);
      return;
    }
    router.push(`/admin/customers/${result.customerId}`);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300"
      >
        New customer
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 rounded-xl border border-ink-800 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">New customer</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-400 hover:underline">
          Cancel
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>First name</span>
          <input className={inputClass} value={form.firstName} onChange={(e) => set("firstName", e.target.value)} required />
        </label>
        <label className="block">
          <span className={labelClass}>Last name</span>
          <input className={inputClass} value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>Phone</span>
          <input className={inputClass} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>Email</span>
          <input className={inputClass} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>Preferred contact</span>
          <select
            className={inputClass}
            value={form.preferredContact}
            onChange={(e) => set("preferredContact", e.target.value as typeof form.preferredContact)}
          >
            <option value="phone">Phone</option>
            <option value="sms">Text message</option>
            <option value="email">Email</option>
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Customer type</span>
          <select
            className={inputClass}
            value={form.customerType}
            onChange={(e) => set("customerType", e.target.value as typeof form.customerType)}
          >
            <option value="individual">Individual</option>
            <option value="business">Business</option>
          </select>
        </label>
        {form.customerType === "business" && (
          <label className="block sm:col-span-2">
            <span className={labelClass}>Company name</span>
            <input className={inputClass} value={form.companyName} onChange={(e) => set("companyName", e.target.value)} />
          </label>
        )}
        <label className="block sm:col-span-2">
          <span className={labelClass}>Notes</span>
          <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
        <input
          type="checkbox"
          className="accent-accent-400"
          checked={form.marketingConsent}
          onChange={(e) => set("marketingConsent", e.target.checked)}
        />
        They agreed to receive review requests and reminders
      </label>

      <label className="mt-5 flex items-center gap-2 text-sm text-ink-300">
        <input
          type="checkbox"
          className="accent-accent-400"
          checked={withVehicle}
          onChange={(e) => setWithVehicle(e.target.checked)}
        />
        Add their vehicle now (needed before they can be booked)
      </label>

      {withVehicle && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={labelClass}>Year</span>
            <input className={inputClass} inputMode="numeric" value={form.year} onChange={(e) => set("year", e.target.value)} />
          </label>
          <label className="block">
            <span className={labelClass}>Make</span>
            <input className={inputClass} value={form.make} onChange={(e) => set("make", e.target.value)} />
          </label>
          <label className="block">
            <span className={labelClass}>Model</span>
            <input className={inputClass} value={form.model} onChange={(e) => set("model", e.target.value)} />
          </label>
          <label className="block">
            <span className={labelClass}>Size category (drives pricing)</span>
            <select
              className={inputClass}
              value={form.category}
              onChange={(e) => set("category", e.target.value as VehicleCategory)}
            >
              {VEHICLE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {VEHICLE_CATEGORY_LABELS[category] ?? category}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Colour</span>
            <input className={inputClass} value={form.colour} onChange={(e) => set("colour", e.target.value)} />
          </label>
          <label className="block">
            <span className={labelClass}>Licence plate</span>
            <input className={inputClass} value={form.licencePlate} onChange={(e) => set("licencePlate", e.target.value)} />
          </label>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="mt-5 rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create customer"}
      </button>
    </form>
  );
}
