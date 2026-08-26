"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { refundAppointmentDepositAction } from "../actions";

/**
 * Returns deposit a downgrade left the shop holding.
 *
 * Shown only when the deposit on the appointment exceeds what the booking is
 * now worth. The refund is recorded against the APPOINTMENT, not the invoice —
 * see refundAppointmentDepositAction for why routing it through the invoice
 * would corrupt the invoice's paid status.
 */
export function DepositRefundPanel({
  appointmentId,
  refundableCents,
  depositPaidCents,
  currency,
  originalMethodWasCard,
}: {
  appointmentId: string;
  refundableCents: number;
  depositPaidCents: number;
  currency: string;
  originalMethodWasCard: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState("cash");
  const [reason, setReason] = useState("Package downgraded at the counter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated once per mount so a double-click cannot record the refund twice.
  const [idempotencyKey] = useState(
    () => `deposit-refund-${appointmentId}-${Math.random().toString(36).slice(2, 12)}`,
  );

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await refundAppointmentDepositAction({
      appointmentId,
      method,
      amountCents: refundableCents,
      reason,
      idempotencyKey,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <section className="mt-4 rounded-xl border border-amber-800/60 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-300">
        Deposit refund owed
      </h2>
      <p className="mt-2 text-sm text-ink-300">
        {formatCents(depositPaidCents, currency)} of deposit is held against a booking now worth
        less than that. <strong className="text-amber-200">{formatCents(refundableCents, currency)}</strong>{" "}
        is owed back.
      </p>
      {originalMethodWasCard && (
        <p className="mt-2 text-xs text-ink-400">
          The deposit was taken online by card. Recording it here logs the refund against the
          appointment — issue the actual card refund from the Stripe dashboard.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-300">
          Method
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="mt-1 block rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
          >
            <option value="cash">Cash</option>
            <option value="etransfer">Interac e-transfer</option>
            <option value="cheque">Cheque</option>
            <option value="card_terminal">Card terminal</option>
          </select>
        </label>
        <label className="min-w-[14rem] flex-1 text-sm text-ink-300">
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
          />
        </label>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || reason.trim().length === 0}
        className="mt-3 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40"
      >
        {busy ? "Recording…" : `Refund ${formatCents(refundableCents, currency)}`}
      </button>
    </section>
  );
}
