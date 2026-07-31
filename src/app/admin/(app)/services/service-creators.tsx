"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BOOKING_MODES } from "@/lib/types";
import { createAddonAction, createServiceAction, createServiceCategoryAction } from "./actions";

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const labelClass = "mb-1 block text-xs text-ink-400";
const primaryButton =
  "rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40";

const BOOKING_MODE_LABELS: Record<string, string> = {
  bookable: "Bookable online",
  quote_required: "Quote required",
  inspection_required: "Inspection required",
  approval_required: "Needs our approval",
  contact_only: "Contact only",
};

/** Dollars in the UI, integer cents in the database. */
function toCents(dollars: string): number | null {
  const value = Number(dollars);
  if (!dollars.trim() || Number.isNaN(value)) return null;
  return Math.round(value * 100);
}

function Disclosure({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={primaryButton}>
        {label}
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-ink-800 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold text-white">{label}</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-400 hover:underline">
          Cancel
        </button>
      </div>
      {children(() => setOpen(false))}
    </div>
  );
}

export function NewServiceForm({
  categories,
}: {
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    categoryId: categories[0]?.id ?? "",
    name: "",
    shortDescription: "",
    price: "",
    baseDurationMin: "60",
    bookingMode: "bookable" as (typeof BOOKING_MODES)[number],
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent, close: () => void) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createServiceAction({
      categoryId: form.categoryId,
      name: form.name,
      shortDescription: form.shortDescription || undefined,
      basePriceCents: toCents(form.price),
      baseDurationMin: Number(form.baseDurationMin),
      bookingMode: form.bookingMode,
      // Created hidden so the owner can review wording and pricing before the
      // public site shows it; the editor below flips it live.
      active: false,
      featured: false,
      depositType: "none",
      depositValue: 0,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    close();
    setForm({ ...form, name: "", shortDescription: "", price: "" });
    router.refresh();
  }

  if (categories.length === 0) {
    return <p className="text-sm text-ink-400">Add a category first, then services can go inside it.</p>;
  }

  return (
    <Disclosure label="New service">
      {(close) => (
        <form onSubmit={(event) => void submit(event, close)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Category</span>
              <select className={inputClass} value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Service name</span>
              <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </label>
            <label className="block">
              <span className={labelClass}>Price ($) — blank means quote only</span>
              <input className={inputClass} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />
            </label>
            <label className="block">
              <span className={labelClass}>Duration (minutes)</span>
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.baseDurationMin}
                onChange={(e) => set("baseDurationMin", e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className={labelClass}>Booking mode</span>
              <select
                className={inputClass}
                value={form.bookingMode}
                onChange={(e) => set("bookingMode", e.target.value as typeof form.bookingMode)}
              >
                {BOOKING_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {BOOKING_MODE_LABELS[mode] ?? mode}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Short description</span>
              <input
                className={inputClass}
                value={form.shortDescription}
                onChange={(e) => set("shortDescription", e.target.value)}
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            Added hidden from the public site. Open it below to set vehicle-size pricing and deposits,
            then tick Active when it is ready to sell.
          </p>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className={`mt-4 ${primaryButton}`}>
            {busy ? "Adding…" : "Add service"}
          </button>
        </form>
      )}
    </Disclosure>
  );
}

export function NewAddonForm({ services }: { services: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [form, setForm] = useState({ name: "", description: "", price: "", durationMin: "30" });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent, close: () => void) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createAddonAction({
      name: form.name,
      description: form.description,
      priceCents: toCents(form.price) ?? 0,
      durationMin: Number(form.durationMin),
      active: true,
      serviceIds,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    close();
    setForm({ name: "", description: "", price: "", durationMin: "30" });
    setServiceIds([]);
    router.refresh();
  }

  return (
    <Disclosure label="New add-on">
      {(close) => (
        <form onSubmit={(event) => void submit(event, close)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Add-on name</span>
              <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} required />
            </label>
            <label className="block">
              <span className={labelClass}>Price ($)</span>
              <input className={inputClass} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} required />
            </label>
            <label className="block">
              <span className={labelClass}>Extra time (minutes)</span>
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.durationMin}
                onChange={(e) => set("durationMin", e.target.value)}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Description</span>
              <input className={inputClass} value={form.description} onChange={(e) => set("description", e.target.value)} />
            </label>
          </div>

          <p className="mt-4 text-xs text-ink-400">Offer this add-on with:</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {services.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm text-ink-200">
                <input
                  type="checkbox"
                  className="accent-accent-400"
                  checked={serviceIds.includes(service.id)}
                  onChange={() =>
                    setServiceIds((prev) =>
                      prev.includes(service.id) ? prev.filter((id) => id !== service.id) : [...prev, service.id],
                    )
                  }
                />
                {service.name}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">
            An add-on can only be chosen alongside a service it is linked to, so leaving every box
            unticked means it will never appear during booking.
          </p>

          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className={`mt-4 ${primaryButton}`}>
            {busy ? "Adding…" : "Add add-on"}
          </button>
        </form>
      )}
    </Disclosure>
  );
}

export function NewCategoryForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function submit(event: React.FormEvent, close: () => void) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createServiceCategoryAction({ name, description: description || undefined });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    close();
    setName("");
    setDescription("");
    router.refresh();
  }

  return (
    <Disclosure label="New category">
      {(close) => (
        <form onSubmit={(event) => void submit(event, close)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Category name</span>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="block">
              <span className={labelClass}>Description</span>
              <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className={`mt-4 ${primaryButton}`}>
            {busy ? "Adding…" : "Add category"}
          </button>
        </form>
      )}
    </Disclosure>
  );
}
