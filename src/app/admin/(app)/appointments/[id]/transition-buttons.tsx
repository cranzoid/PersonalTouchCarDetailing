"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { recordAppointmentDepositAction, transitionAppointmentAction } from "../actions";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "etransfer", label: "E-transfer" },
  { value: "card_terminal", label: "Card terminal" },
] as const;

function newIdempotencyKey(): string {
  return `appointment_deposit_${globalThis.crypto.randomUUID()}`;
}

const ACTIONS: Record<string, { to: "confirmed" | "arrived" | "cancelled" | "no_show" | "completed"; label: string; danger?: boolean; needsReason?: boolean }[]> = {
  pending: [
    { to: "confirmed", label: "Confirm" },
    { to: "cancelled", label: "Cancel", danger: true, needsReason: true },
  ],
  deposit_required: [{ to: "cancelled", label: "Cancel", danger: true, needsReason: true }],
  confirmed: [
    { to: "arrived", label: "Mark Arrived" },
    { to: "no_show", label: "No-show", danger: true },
    { to: "cancelled", label: "Cancel", danger: true, needsReason: true },
  ],
  arrived: [{ to: "completed", label: "Mark Completed" }],
};

export function TransitionButtons({
  appointmentId,
  status,
  depositRequiredCents,
  depositPaidCents,
}: {
  appointmentId: string;
  status: string;
  depositRequiredCents: number;
  depositPaidCents: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [depositMethod, setDepositMethod] = useState<(typeof PAYMENT_METHODS)[number]["value"]>("cash");
  const [depositIdempotencyKey, setDepositIdempotencyKey] = useState(newIdempotencyKey);
  const actions = ACTIONS[status] ?? [];
  const remainingDepositCents = Math.max(0, depositRequiredCents - depositPaidCents);
  if (actions.length === 0 && status !== "deposit_required") return null;

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

  async function recordDeposit() {
    if (remainingDepositCents <= 0) {
      setError("No deposit balance remains");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await recordAppointmentDepositAction({
      appointmentId,
      method: depositMethod,
      amountCents: remainingDepositCents,
      idempotencyKey: depositIdempotencyKey,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setDepositIdempotencyKey(newIdempotencyKey());
      router.refresh();
    }
  }

  return (
    <div className="mt-4">
      {status === "deposit_required" && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-amber-800/60 p-3">
          <label className="text-xs text-ink-400">
            Deposit method
            <select
              value={depositMethod}
              onChange={(event) => setDepositMethod(event.target.value as typeof depositMethod)}
              disabled={busy}
              className="mt-1 block rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white"
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || remainingDepositCents <= 0}
            onClick={() => void recordDeposit()}
            className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            Record ${(remainingDepositCents / 100).toFixed(2)} deposit & confirm
          </button>
        </div>
      )}
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
