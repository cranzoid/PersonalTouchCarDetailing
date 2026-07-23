"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  sendEstimateAction,
  getEstimateSlotsAction,
  convertEstimateAction,
} from "../actions";

export function EstimateActions({
  estimateId,
  status,
  suggestedDurationMin,
  hasVehicle,
}: {
  estimateId: string;
  status: string;
  suggestedDurationMin: number;
  hasVehicle: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<"email" | "sms" | null>(null);

  // Conversion widget state
  const [dateISO, setDateISO] = useState("");
  const [durationMin, setDurationMin] = useState(String(suggestedDurationMin));
  const [slots, setSlots] = useState<{ startMs: number; label: string }[] | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);

  const canSend = ["draft", "sent", "viewed", "changes_requested"].includes(status);
  const canConvert = status === "approved";

  async function send() {
    setBusy(true);
    setError(null);
    const res = await sendEstimateAction({ estimateId });
    setBusy(false);
    if (res.ok) {
      setLink(res.link);
      setDelivery(res.delivery);
      router.refresh();
    } else setError(res.error);
  }

  async function loadSlots() {
    if (!dateISO) return;
    setBusy(true);
    setError(null);
    setSlots(null);
    setStartMs(null);
    const res = await getEstimateSlotsAction({ estimateId, dateISO, durationMin: Number(durationMin) });
    setBusy(false);
    if (res.ok) setSlots(res.slots);
    else setError(res.error);
  }

  async function convert() {
    if (!dateISO || startMs === null) return;
    setBusy(true);
    setError(null);
    const res = await convertEstimateAction({
      estimateId,
      dateISO,
      startMs,
      durationMin: Number(durationMin),
    });
    setBusy(false);
    if (res.ok) router.push(`/admin/appointments/${res.appointmentId}`);
    else setError(res.error);
  }

  const input = "rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

  return (
    <section className="mt-8 space-y-4 rounded-xl border border-ink-800 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Actions</h2>

      {canSend && (
        <div>
          <button
            onClick={send}
            disabled={busy}
            className="rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {status === "draft" ? "Send to Customer" : "Re-send (new link)"}
          </button>
          <p className="mt-2 text-xs text-ink-500">
            Generates a secure single-purpose approval link (previous links are revoked) and sends
            the active template through its configured channel when possible.
          </p>
          {link && (
            <div className="mt-2 rounded-lg bg-ink-900 p-3 text-xs">
              <p className={delivery ? "text-emerald-300" : "text-amber-300"}>
                {delivery ? `Link sent by ${delivery}.` : "Link created but was not sent; copy it below."}
              </p>
              <p className="mt-1 break-all font-mono text-emerald-300">{link}</p>
            </div>
          )}
        </div>
      )}

      {canConvert && (
        <div className="space-y-3">
          <p className="text-sm text-ink-300">Book the approved work in:</p>
          {!hasVehicle && (
            <p className="text-sm text-amber-300">
              This estimate has no vehicle on file — add one to the customer before converting.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-400">
              Date
              <input type="date" className={`${input} mt-1 block`} value={dateISO} onChange={(e) => setDateISO(e.target.value)} />
            </label>
            <label className="block text-xs text-ink-400">
              Duration (min)
              <input type="number" min={15} step={15} className={`${input} mt-1 block w-28`} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
            </label>
            <button
              onClick={loadSlots}
              disabled={busy || !dateISO}
              className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-400 disabled:opacity-40"
            >
              Check Availability
            </button>
          </div>
          {slots && slots.length === 0 && <p className="text-sm text-ink-500">No free slots that day.</p>}
          {slots && slots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button
                  key={s.startMs}
                  onClick={() => setStartMs(s.startMs)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    startMs === s.startMs
                      ? "border-accent-400 bg-accent-400/10 text-accent-300"
                      : "border-ink-700 text-ink-300 hover:border-accent-400"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {startMs !== null && (
            <button
              onClick={convert}
              disabled={busy || !hasVehicle}
              className="rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
            >
              {busy ? "Converting…" : "Create Appointment"}
            </button>
          )}
        </div>
      )}

      {!canSend && !canConvert && (
        <p className="text-sm text-ink-500">No actions available for a {status.replaceAll("_", " ")} estimate.</p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
