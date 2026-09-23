"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { localDateISO } from "@/lib/tz";
import { getRescheduleSlotsAction, rescheduleAppointmentAction } from "../actions";

export function ReschedulePanel({ appointmentId, maxBookingWindowDays, timezone }: { appointmentId: string; maxBookingWindowDays: number; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dateISO, setDateISO] = useState("");
  const [timeMode, setTimeMode] = useState<"slots" | "override">("slots");
  const [slots, setSlots] = useState<Array<{ startMs: number; label: string }> | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [overrideTime, setOverrideTime] = useState("");
  /** What the server says an override breaks; set means "Move anyway" is on offer. */
  const [overrideWarnings, setOverrideWarnings] = useState<string[] | null>(null);
  const [allowOutsideWindow, setAllowOutsideWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Business-local dates: toISOString() reports the UTC day, which pushed the
  // earliest selectable date out by one for anyone working late in Toronto.
  // A time override has no bounds at all: that is what it is for.
  const unbounded = allowOutsideWindow || timeMode === "override";
  const minDate = unbounded ? undefined : localDateISO(timezone, 86_400_000);
  const maxDate = unbounded ? undefined : localDateISO(timezone, maxBookingWindowDays * 86_400_000);
  const canSave = Boolean(dateISO) && (timeMode === "slots" ? startMs !== null : Boolean(overrideTime));

  function resetTime() {
    setSlots(null);
    setStartMs(null);
    setOverrideWarnings(null);
  }

  async function loadSlots() {
    setBusy(true);
    setError(null);
    const result = await getRescheduleSlotsAction({ appointmentId, dateISO, allowOutsideBookingWindow: allowOutsideWindow });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSlots(result.slots);
    setStartMs(null);
  }

  async function save(confirmOverride = false) {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const time =
      timeMode === "slots"
        ? { startMs: startMs!, allowOutsideBookingWindow: allowOutsideWindow }
        : { timeOverride: true, overrideTime, confirmOverride };
    const result = await rescheduleAppointmentAction({ appointmentId, dateISO, ...time });
    setBusy(false);
    if (!result.ok) {
      if ("needsOverrideConfirm" in result) return setOverrideWarnings(result.warnings);
      return setError(result.error);
    }
    setOpen(false);
    resetTime();
    router.refresh();
  }

  return <section className="mt-4 rounded-xl border border-ink-800 p-4">
    <button type="button" onClick={() => setOpen(!open)} className="text-sm font-medium text-accent-300 hover:underline">{open ? "Close rescheduling" : "Reschedule appointment"}</button>
    {open && <div className="mt-4">
      <div className="inline-flex rounded-lg border border-ink-700 p-1 text-sm" role="group" aria-label="How to pick the new time">
        {(["slots", "override"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={timeMode === mode}
            onClick={() => { setTimeMode(mode); resetTime(); setError(null); }}
            className={`rounded-md px-3 py-1.5 ${timeMode === mode ? "bg-accent-400 font-semibold text-ink-950" : "text-ink-300 hover:text-white"}`}
          >
            {mode === "slots" ? "Open slots" : "Any time (override)"}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-300">New date<input type="date" min={minDate} max={maxDate} value={dateISO} onChange={(event) => { setDateISO(event.target.value); resetTime(); }} className="mt-1 block rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white" /></label>
        {timeMode === "slots" ? (
          <button type="button" onClick={() => void loadSlots()} disabled={busy || !dateISO} className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 disabled:opacity-40">{busy ? "Checking…" : "Check real slots"}</button>
        ) : (
          <label className="text-sm text-ink-300">Start time<input type="time" step={300} value={overrideTime} onChange={(event) => { setOverrideTime(event.target.value); resetTime(); }} className="mt-1 block rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white" /></label>
        )}
      </div>
      {timeMode === "slots" ? (
        <>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={allowOutsideWindow}
              onChange={(event) => { setAllowOutsideWindow(event.target.checked); resetTime(); }}
              className="accent-accent-400"
            />
            Allow past and same-day dates
          </label>
          {slots && slots.length === 0 && <p className="mt-3 text-sm text-ink-500">No openings on this date. To move it later than the last slot, use Any time (override).</p>}
          {slots && slots.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">{slots.map((slot) => <button type="button" key={slot.startMs} onClick={() => setStartMs(slot.startMs)} className={`rounded-lg border px-3 py-2 text-sm ${startMs === slot.startMs ? "border-accent-400 bg-accent-400 font-semibold text-ink-950" : "border-ink-700 text-ink-200"}`}>{slot.label}</button>)}</div>}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          Moves it to exactly this time — before opening, at or after closing, or on a day the shop is
          shut. Anything it overrides is listed for you to confirm first.
        </p>
      )}
      {overrideWarnings && (
        <div className="mt-3 rounded-lg border border-amber-800/60 p-3 text-sm text-amber-300">
          <p className="font-medium">This time overrides the schedule:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {overrideWarnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          <button type="button" onClick={() => void save(true)} disabled={busy} className="mt-3 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Move anyway"}</button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {!overrideWarnings && (
        <button type="button" onClick={() => void save()} disabled={busy || !canSave} className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Confirm new time"}</button>
      )}
      <p className="mt-2 text-xs text-ink-500">The appointment keeps its current payment/confirmation status. Any queued reminder is reset.</p>
    </div>}
  </section>;
}
