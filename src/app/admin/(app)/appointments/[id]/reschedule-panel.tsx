"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { localDateISO } from "@/lib/tz";
import { getRescheduleSlotsAction, rescheduleAppointmentAction } from "../actions";

export function ReschedulePanel({ appointmentId, maxBookingWindowDays, timezone }: { appointmentId: string; maxBookingWindowDays: number; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<Array<{ startMs: number; label: string }> | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [allowOutsideWindow, setAllowOutsideWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Business-local dates: toISOString() reports the UTC day, which pushed the
  // earliest selectable date out by one for anyone working late in Toronto.
  const minDate = allowOutsideWindow ? undefined : localDateISO(timezone, 86_400_000);
  const maxDate = allowOutsideWindow ? undefined : localDateISO(timezone, maxBookingWindowDays * 86_400_000);

  async function loadSlots() {
    setBusy(true);
    setError(null);
    const result = await getRescheduleSlotsAction({ appointmentId, dateISO, allowOutsideBookingWindow: allowOutsideWindow });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSlots(result.slots);
    setStartMs(null);
  }

  async function save() {
    if (!startMs) return;
    setBusy(true);
    setError(null);
    const result = await rescheduleAppointmentAction({ appointmentId, dateISO, startMs, allowOutsideBookingWindow: allowOutsideWindow });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setOpen(false);
    router.refresh();
  }

  return <section className="mt-4 rounded-xl border border-ink-800 p-4">
    <button type="button" onClick={() => setOpen(!open)} className="text-sm font-medium text-accent-300 hover:underline">{open ? "Close rescheduling" : "Reschedule appointment"}</button>
    {open && <div className="mt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-300">New date<input type="date" min={minDate} max={maxDate} value={dateISO} onChange={(event) => { setDateISO(event.target.value); setSlots(null); setStartMs(null); }} className="mt-1 block rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white" /></label>
        <button type="button" onClick={() => void loadSlots()} disabled={busy || !dateISO} className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 disabled:opacity-40">{busy ? "Checking…" : "Check real slots"}</button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
        <input
          type="checkbox"
          checked={allowOutsideWindow}
          onChange={(event) => { setAllowOutsideWindow(event.target.checked); setSlots(null); setStartMs(null); }}
          className="accent-accent-400"
        />
        Allow past and same-day dates
      </label>
      {slots && slots.length === 0 && <p className="mt-3 text-sm text-ink-500">No openings on this date.</p>}
      {slots && slots.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">{slots.map((slot) => <button type="button" key={slot.startMs} onClick={() => setStartMs(slot.startMs)} className={`rounded-lg border px-3 py-2 text-sm ${startMs === slot.startMs ? "border-accent-400 bg-accent-400 font-semibold text-ink-950" : "border-ink-700 text-ink-200"}`}>{slot.label}</button>)}</div>}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button type="button" onClick={() => void save()} disabled={busy || startMs === null} className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Confirm new time"}</button>
      <p className="mt-2 text-xs text-ink-500">The appointment keeps its current payment/confirmation status. Any queued reminder is reset.</p>
    </div>}
  </section>;
}
