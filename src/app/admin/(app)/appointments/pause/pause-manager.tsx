"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBookingPauseAction, endBookingPauseAction, type ActionResult } from "./actions";

type PauseSummary = {
  id: string;
  /** Started already: lifting it resumes bookings now. */
  active: boolean;
  startsLabel: string;
  endsLabel: string;
  reason: string | null;
};

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

export function PauseManager({ pauses }: { pauses: PauseSummary[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ startsLocal: "", endsLocal: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const pausedNow = pauses.find((pause) => pause.active);

  async function run(action: () => Promise<ActionResult>, done: string) {
    setBusy(true);
    setMessage(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setMessage({ ok: false, text: result.error });
    setMessage({ ok: true, text: done });
    router.refresh();
  }

  function pausePreset(preset: "rest_of_today" | "tomorrow") {
    void run(
      () => createBookingPauseAction({ kind: "preset", preset, reason: form.reason }),
      preset === "rest_of_today" ? "Online bookings are paused for the rest of today." : "Online bookings are paused for tomorrow.",
    );
  }

  async function pauseCustom(event: React.FormEvent) {
    event.preventDefault();
    await run(() => createBookingPauseAction({ kind: "custom", ...form }), "Online bookings are paused for that time.");
    setForm({ startsLocal: "", endsLocal: "", reason: "" });
  }

  function lift(pause: PauseSummary) {
    const question = pause.active
      ? "Resume online bookings now? Customers will be able to book the remaining free times straight away."
      : "Cancel this upcoming pause?";
    if (!window.confirm(question)) return;
    void run(() => endBookingPauseAction({ pauseId: pause.id }), pause.active ? "Online bookings resumed." : "Pause cancelled.");
  }

  return (
    <>
      <div className={`mt-6 rounded-xl border p-4 text-sm ${pausedNow ? "border-amber-300 bg-amber-50 text-amber-900" : "border-ink-800 text-ink-300"}`}>
        {pausedNow ? (
          <p><span className="font-semibold">Online bookings are paused right now</span>, until {pausedNow.endsLabel}.</p>
        ) : (
          <p><span className="font-semibold text-white">Online bookings are open.</span></p>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Quick pause</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => pausePreset("rest_of_today")} className="rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 disabled:opacity-40">
            Pause the rest of today
          </button>
          <button type="button" disabled={busy} onClick={() => pausePreset("tomorrow")} className="rounded-lg border border-ink-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
            Pause all of tomorrow
          </button>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Pause a specific time</h2>
        <p className="mt-2 text-xs leading-5 text-ink-500">
          For part of a day, a whole future day, or several days. A booking is refused if any of it would fall
          inside the pause. Coatings are booked by date, so they are only stopped by a pause covering the whole
          working day.
        </p>
        <form onSubmit={pauseCustom} className="mt-4 grid gap-3 rounded-xl border border-ink-800 p-4 sm:grid-cols-2">
          <label className="text-xs text-ink-400">From
            <input required type="datetime-local" value={form.startsLocal} onChange={(event) => setForm({ ...form, startsLocal: event.target.value })} className={`${inputClass} mt-1`} />
          </label>
          <label className="text-xs text-ink-400">Until
            <input required type="datetime-local" value={form.endsLocal} onChange={(event) => setForm({ ...form, endsLocal: event.target.value })} className={`${inputClass} mt-1`} />
          </label>
          <label className="text-xs text-ink-400 sm:col-span-2">Note for staff (optional)
            <input maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Fully booked, short-staffed…" className={`${inputClass} mt-1`} />
          </label>
          <button disabled={busy} className="justify-self-start rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">
            {busy ? "Saving…" : "Pause bookings"}
          </button>
        </form>
      </section>

      {message && <p className={`mt-4 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Current and upcoming pauses</h2>
        <div className="mt-3 space-y-2">
          {pauses.map((pause) => (
            <article key={pause.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-800 p-4 text-sm">
              <div>
                <p className="font-medium text-white">
                  {pause.active && <span className="mr-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Paused now</span>}
                  {pause.startsLabel} → {pause.endsLabel}
                </p>
                {pause.reason && <p className="mt-1 text-xs text-ink-500">{pause.reason}</p>}
              </div>
              <button type="button" onClick={() => lift(pause)} disabled={busy} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                {pause.active ? "Resume bookings" : "Cancel pause"}
              </button>
            </article>
          ))}
          {pauses.length === 0 && <p className="text-sm text-ink-500">No pauses. Customers can book any free time.</p>}
        </div>
      </section>
    </>
  );
}
