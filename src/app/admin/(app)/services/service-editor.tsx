"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BOOKING_MODES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import {
  updateAddonAction,
  updateServiceAction,
  updateVehicleAdjustmentAction,
} from "./actions";

type EditableAdjustment = {
  id: string;
  vehicleCategory: string;
  priceDeltaCents: number;
  durationDeltaMin: number;
};

type EditableService = {
  id: string;
  name: string;
  shortDescription: string;
  basePriceCents: number | null;
  baseDurationMin: number;
  bookingMode: string;
  active: boolean;
  featured: boolean;
  depositType: string;
  depositValue: number;
};

export function ServiceEditor({
  service,
  adjustments,
}: {
  service: EditableService;
  adjustments: EditableAdjustment[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    name: service.name,
    shortDescription: service.shortDescription,
    price: service.basePriceCents !== null ? (service.basePriceCents / 100).toFixed(2) : "",
    duration: String(service.baseDurationMin),
    bookingMode: service.bookingMode,
    active: service.active,
    featured: service.featured,
    depositType: service.depositType,
    depositValue: String(service.depositValue),
  });

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await updateServiceAction({
      serviceId: service.id,
      name: form.name,
      shortDescription: form.shortDescription || undefined,
      basePriceCents: form.price.trim() === "" ? null : Math.round(Number(form.price) * 100),
      baseDurationMin: Number(form.duration),
      bookingMode: form.bookingMode,
      active: form.active,
      featured: form.featured,
      depositType: form.depositType,
      depositValue: Number(form.depositValue),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setSaved(true);
      router.refresh();
    }
  }

  const input =
    "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-1.5 text-sm text-white";

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span>
          <span className={`font-medium ${service.active ? "text-white" : "text-ink-500 line-through"}`}>
            {service.name}
          </span>
          <span className="ml-3 text-xs uppercase tracking-wider text-ink-500">
            {service.bookingMode.replaceAll("_", " ")}
          </span>
        </span>
        <span className="text-sm text-accent-300">
          {service.basePriceCents !== null ? `$${(service.basePriceCents / 100).toFixed(2)}` : "By quote"}
          <span className="ml-3 text-ink-500">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-800 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-400">Name</span>
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-400">Short description</span>
              <input className={input} value={form.shortDescription} onChange={(e) => setForm({ ...form, shortDescription: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-400">Base price (CAD, blank = quote only)</span>
              <input className={input} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="e.g. 189.00" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-400">Duration (minutes)</span>
              <input className={input} value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-400">Booking mode</span>
              <select className={input} value={form.bookingMode} onChange={(e) => setForm({ ...form, bookingMode: e.target.value })}>
                {BOOKING_MODES.map((m) => (
                  <option key={m} value={m}>{m.replaceAll("_", " ")}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-400">Deposit type</span>
                <select className={input} value={form.depositType} onChange={(e) => setForm({ ...form, depositType: e.target.value })}>
                  <option value="none">none</option>
                  <option value="fixed">fixed ($ cents)</option>
                  <option value="percent">percent (bp)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-400">Deposit value</span>
                <input className={input} value={form.depositValue} onChange={(e) => setForm({ ...form, depositValue: e.target.value })} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active (visible &amp; bookable on the public site)
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
              Featured on home page
            </label>
          </div>
          {adjustments.length > 0 && (
            <div className="mt-5 border-t border-ink-800 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                Vehicle price and time adjustments
              </p>
              <p className="mt-1 text-xs text-ink-500">
                These amounts are added to the base price and duration above.
              </p>
              <div className="mt-3 space-y-2">
                {adjustments.map((adjustment) => (
                  <VehicleAdjustmentEditor key={adjustment.id} adjustment={adjustment} />
                ))}
              </div>
            </div>
          )}
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          {saved && <p className="mt-3 text-sm text-emerald-300">Saved.</p>}
          <button
            onClick={() => void save()}
            disabled={busy}
            className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save Changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function VehicleAdjustmentEditor({ adjustment }: { adjustment: EditableAdjustment }) {
  const router = useRouter();
  const [price, setPrice] = useState((adjustment.priceDeltaCents / 100).toFixed(2));
  const [duration, setDuration] = useState(String(adjustment.durationDeltaMin));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-1.5 text-sm text-white";
  const label =
    VEHICLE_CATEGORY_LABELS[adjustment.vehicleCategory as VehicleCategory] ??
    adjustment.vehicleCategory;

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await updateVehicleAdjustmentAction({
      adjustmentId: adjustment.id,
      vehicleCategory: adjustment.vehicleCategory,
      priceDeltaCents: Math.round(Number(price) * 100),
      durationDeltaMin: Number(duration),
    });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }

  return (
    <div className="grid items-end gap-2 rounded-lg border border-ink-800 p-3 sm:grid-cols-[1fr_8rem_8rem_auto]">
      <span className="self-center text-sm text-ink-300">{label}</span>
      <label>
        <span className="mb-1 block text-xs text-ink-500">Price extra (CAD)</span>
        <input className={input} value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label>
        <span className="mb-1 block text-xs text-ink-500">Minutes extra</span>
        <input className={input} value={duration} onChange={(e) => setDuration(e.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="rounded-lg border border-accent-400 px-3 py-2 text-xs font-semibold text-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {msg && (
        <p className={`text-xs sm:col-start-2 sm:col-span-3 ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

type EditableAddon = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  durationMin: number;
  active: boolean;
};

export function AddonEditor({ addon }: { addon: EditableAddon }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    name: addon.name,
    description: addon.description,
    price: (addon.priceCents / 100).toFixed(2),
    duration: String(addon.durationMin),
    active: addon.active,
  });
  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-1.5 text-sm text-white";

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await updateAddonAction({
      addonId: addon.id,
      name: form.name,
      description: form.description,
      priceCents: Math.round(Number(form.price) * 100),
      durationMin: Number(form.duration),
      active: form.active,
    });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs text-ink-400">Name</span>
          <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          <span className="mb-1 block text-xs text-ink-400">Description</span>
          <input className={input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <label>
          <span className="mb-1 block text-xs text-ink-400">Price (CAD)</span>
          <input className={input} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </label>
        <label>
          <span className="mb-1 block text-xs text-ink-400">Extra duration (minutes)</span>
          <input className={input} value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Active
        </label>
      </div>
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save Add-on"}
      </button>
    </div>
  );
}
