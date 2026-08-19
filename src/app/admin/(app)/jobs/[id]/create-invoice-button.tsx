"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  PAYMENT_METHOD_TAXABLE,
  QUOTED_PAYMENT_METHODS,
  QUOTED_PAYMENT_METHOD_LABELS,
  type QuotedPaymentMethod,
} from "@/lib/types";
import { createInvoiceFromJobAction } from "../../invoices/actions";

/**
 * Turns a ready-for-pickup/completed job into a draft invoice and opens it.
 *
 * The payment method is asked for here rather than at check-in because the
 * invoice is the tax document: it is the step that decides whether HST is
 * charged, and the owner declined a separate counter-sale screen.
 */
export function CreateInvoiceButton({ jobId, taxLabel }: { jobId: string; taxLabel: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<QuotedPaymentMethod>("cash");

  const taxed = PAYMENT_METHOD_TAXABLE[paymentMethod];

  async function run() {
    setBusy(true);
    setError(null);
    const res = await createInvoiceFromJobAction({ jobId, paymentMethod });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.push(`/admin/invoices/${res.invoiceId}`);
  }

  return (
    <div>
      <label className="block text-xs text-ink-400">
        How will they pay?
        <select
          className="mt-1 block rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white"
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value as QuotedPaymentMethod)}
        >
          {QUOTED_PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {QUOTED_PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <p className={`mt-2 text-xs ${taxed ? "text-ink-500" : "text-amber-300"}`}>
        {taxed
          ? `${taxLabel} is added to this invoice.`
          : `No ${taxLabel} is charged on cash or e-transfer sales. The customer must pay by this method — changing it later means cancelling and re-issuing.`}
      </p>
      <button
        disabled={busy}
        onClick={() => void run()}
        className="mt-3 rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create Invoice"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
