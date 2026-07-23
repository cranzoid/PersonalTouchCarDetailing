"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  sendInvoiceAction,
  recordPaymentAction,
  issueRefundAction,
  cancelInvoiceAction,
} from "../actions";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "etransfer", label: "E-transfer" },
  { value: "card_terminal", label: "Card terminal" },
] as const;

const MANUAL_REFUND_METHODS = [
  { value: "cash", label: "Cash (already returned)" },
  { value: "etransfer", label: "E-transfer (already sent)" },
  { value: "card_terminal", label: "Card terminal (already issued)" },
] as const;

function newIdempotencyKey(kind: "payment" | "refund"): string {
  return `${kind}_${globalThis.crypto.randomUUID()}`;
}

export function InvoiceActions({
  invoiceId,
  status,
  balanceCents,
  netPaidCents,
  stripeRefundableCents,
  manualRefundableCents,
}: {
  invoiceId: string;
  status: string;
  balanceCents: number;
  netPaidCents: number;
  stripeRefundableCents: number;
  manualRefundableCents: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<"email" | "sms" | null>(null);

  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]["value"]>("cash");
  const [amount, setAmount] = useState("");
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState(() => newIdempotencyKey("payment"));
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundMessage, setRefundMessage] = useState<string | null>(null);
  const [refundMethod, setRefundMethod] = useState<"stripe" | "cash" | "etransfer" | "card_terminal">(
    stripeRefundableCents > 0 ? "stripe" : "cash",
  );
  const [refundIdempotencyKey, setRefundIdempotencyKey] = useState(() => newIdempotencyKey("refund"));
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);

  const canSend = ["draft", "sent", "partially_paid", "overdue"].includes(status);
  const canTakePayment = balanceCents > 0 && !["cancelled", "refunded"].includes(status);
  const canRefund = netPaidCents > 0 && stripeRefundableCents + manualRefundableCents > 0;
  const canCancel = ["draft", "sent", "overdue"].includes(status) && netPaidCents === 0;

  async function send() {
    setBusy(true);
    setError(null);
    const res = await sendInvoiceAction({ invoiceId });
    setBusy(false);
    if (res.ok) {
      setLink(res.link);
      setDelivery(res.delivery);
      router.refresh();
    } else setError(res.error);
  }

  async function recordPayment() {
    const cents = Math.round(Number(amount) * 100);
    if (!cents || cents <= 0) {
      setError("Enter a payment amount");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await recordPaymentAction({
      invoiceId,
      method,
      amountCents: cents,
      idempotencyKey: paymentIdempotencyKey,
    });
    setBusy(false);
    if (res.ok) {
      setAmount("");
      setPaymentIdempotencyKey(newIdempotencyKey("payment"));
      router.refresh();
    } else setError(res.error);
  }

  async function refund() {
    const cents = Math.round(Number(refundAmount) * 100);
    if (!cents || cents <= 0) {
      setError("Enter a refund amount");
      return;
    }
    if (!refundReason.trim()) {
      setError("A reason is required for a refund");
      return;
    }
    setBusy(true);
    setError(null);
    setRefundMessage(null);
    const res = await issueRefundAction({
      invoiceId,
      amountCents: cents,
      reason: refundReason.trim(),
      idempotencyKey: refundIdempotencyKey,
      method: refundMethod,
    });
    setBusy(false);
    if (res.ok) {
      setRefundMessage(
        res.status === "pending"
          ? "Stripe accepted the request and is still processing it. The invoice will update after confirmation."
          : "Refund recorded successfully.",
      );
      setRefundAmount("");
      setRefundReason("");
      setRefundIdempotencyKey(newIdempotencyKey("refund"));
      router.refresh();
    } else setError(res.error);
  }

  async function cancel() {
    if (!cancelReason.trim()) {
      setError("A reason is required to cancel");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await cancelInvoiceAction({ invoiceId, reason: cancelReason.trim() });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.error);
  }

  const input = "rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

  if (!canSend && !canTakePayment && !canRefund && !canCancel) {
    return (
      <section className="mt-8 rounded-xl border border-ink-800 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Actions</h2>
        <p className="mt-2 text-sm text-ink-500">No actions available for a {status.replaceAll("_", " ")} invoice.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 space-y-6 rounded-xl border border-ink-800 p-5">
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
            Generates a secure link where the customer can view the invoice and pay online.
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

      {canTakePayment && (
        <div className="border-t border-ink-800 pt-5">
          <p className="text-sm font-medium text-white">Record a manual payment</p>
          <p className="mt-1 text-xs text-ink-500">Cash, e-transfer or a card terminal handled outside Stripe.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-400">
              Method
              <select
                className={`${input} mt-1 block`}
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-ink-400">
              Amount
              <input
                type="number"
                min="0"
                step="0.01"
                className={`${input} mt-1 block w-32`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <button
              onClick={recordPayment}
              disabled={busy}
              className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
            >
              Record Payment
            </button>
          </div>
        </div>
      )}

      {canRefund && (
        <div className="border-t border-ink-800 pt-5">
          <p className="text-sm font-medium text-white">Issue a refund</p>
          <p className="mt-1 text-xs text-ink-500">
            Stripe refunds are issued here. Select a manual route only after returning the funds outside this app.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-400">
              Route
              <select
                className={`${input} mt-1 block`}
                value={refundMethod}
                onChange={(event) => setRefundMethod(event.target.value as typeof refundMethod)}
              >
                {stripeRefundableCents > 0 && (
                  <option value="stripe">Stripe ({(stripeRefundableCents / 100).toFixed(2)} available)</option>
                )}
                {manualRefundableCents > 0 && MANUAL_REFUND_METHODS.map((refundMethodOption) => (
                  <option key={refundMethodOption.value} value={refundMethodOption.value}>
                    {refundMethodOption.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-ink-400">
              Amount
              <input
                type="number"
                min="0"
                step="0.01"
                className={`${input} mt-1 block w-32`}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <label className="block flex-1 text-xs text-ink-400">
              Reason
              <input
                className={`${input} mt-1 block w-full`}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Why is this being refunded?"
              />
            </label>
            <button
              onClick={refund}
              disabled={busy}
              className="rounded-lg border border-amber-800 px-4 py-2 text-sm font-medium text-amber-300 hover:bg-amber-950/40 disabled:opacity-40"
            >
              Issue Refund
            </button>
          </div>
          {refundMessage && <p className="mt-2 text-sm text-emerald-300">{refundMessage}</p>}
        </div>
      )}

      {canCancel && (
        <div className="border-t border-ink-800 pt-5">
          {!showCancel ? (
            <button
              onClick={() => setShowCancel(true)}
              className="text-sm text-red-400 hover:underline"
            >
              Cancel this invoice
            </button>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block flex-1 text-xs text-ink-400">
                Reason
                <input
                  className={`${input} mt-1 block w-full`}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Why is this being cancelled?"
                />
              </label>
              <button
                onClick={cancel}
                disabled={busy}
                className="rounded-lg border border-red-800 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950/40 disabled:opacity-40"
              >
                Confirm Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
