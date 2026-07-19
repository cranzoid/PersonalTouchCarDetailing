"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { transitionAppointmentAction } from "../actions";

const ACTIONS: Record<string, { to: "confirmed" | "arrived" | "cancelled" | "no_show" | "completed"; label: string; danger?: boolean; needsReason?: boolean }[]> = {
  pending: [
    { to: "confirmed", label: "Confirm" },
    { to: "cancelled", label: "Cancel", danger: true, needsReason: true },
  ],
  deposit_required: [
    { to: "confirmed", label: "Confirm (deposit received)" },
    { to: "cancelled", label: "Cancel", danger: true, needsReason: true },
  ],
  confirmed: [
    { to: "arrived", label: "Mark Arrived" },
    { to: "no_show", label: "No-show", danger: true },
    { to: "cancelled", label: "Cancel", danger: true, needsReason: true },
  ],
  arrived: [{ to: "completed", label: "Mark Completed" }],
};

export function TransitionButtons({ appointmentId, status }: { appointmentId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = ACTIONS[status] ?? [];
  if (actions.length === 0) return null;

  async function run(to: (typeof actions)[number]["to"], needsReason?: boolean) {
    let reason: string | undefined;
    if (needsReason) {
      // eslint-disable-next-line no-alert
      reason = window.prompt("Reason for cancellation (required):") ?? undefined;
      if (!reason?.trim()) return;
    }
    setBusy(true);
    setError(null);
    const res = await transitionAppointmentAction({ appointmentId, to, reason });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.to}
            disabled={busy}
            onClick={() => void run(a.to, a.needsReason)}
            className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40 ${
              a.danger
                ? "border border-red-800 text-red-300 hover:bg-red-950"
                : "bg-accent-400 text-ink-950 hover:bg-accent-300"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
