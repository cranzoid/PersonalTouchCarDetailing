"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  PAYMENT_METHOD_TAXABLE,
  QUOTED_PAYMENT_METHODS,
  QUOTED_PAYMENT_METHOD_LABELS,
  type QuotedPaymentMethod,
} from "@/lib/types";
import { createConsolidatedInvoiceAction } from "../invoices/actions";

export type EligibleFleetJob = {
  id: string;
  status: string;
  vehicleLabel: string;
  completedLabel: string;
};

export function ConsolidatedInvoiceBuilder({
  customerId,
  jobs,
  taxLabel,
}: {
  customerId: string;
  jobs: EligibleFleetJob[];
  taxLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fleet accounts most often settle on account by cheque, so that is the
  // default here rather than the cash default on a walk-in job.
  const [paymentMethod, setPaymentMethod] = useState<QuotedPaymentMethod>("cheque");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const jobIds = form.getAll("jobId").map(String);
    const result = await createConsolidatedInvoiceAction({ customerId, jobIds, paymentMethod });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/invoices/${result.invoiceId}`);
    router.refresh();
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-800 p-5">
      <h2 className="text-lg font-semibold text-white">Build consolidated invoice</h2>
      <p className="mt-1 text-sm text-ink-400">Combine ready or completed, uninvoiced jobs into one fleet bill.</p>
      {jobs.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">No eligible jobs are ready to invoice.</p>
      ) : (
        <form onSubmit={submit} className="mt-4">
          <div className="space-y-2">
            {jobs.map((job) => (
              <label key={job.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-800 p-3 hover:border-accent-500/50">
                <input name="jobId" value={job.id} type="checkbox" className="mt-1 h-4 w-4 accent-accent-400" />
                <span>
                  <span className="block text-sm font-medium text-white">{job.vehicleLabel}</span>
                  <span className="block text-xs capitalize text-ink-500">{job.status.replaceAll("_", " ")} · {job.completedLabel} · {job.id}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="mt-4 block text-xs text-ink-400">
            How will this account pay?
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
          <p className={`mt-2 text-xs ${PAYMENT_METHOD_TAXABLE[paymentMethod] ? "text-ink-500" : "text-amber-300"}`}>
            {PAYMENT_METHOD_TAXABLE[paymentMethod]
              ? `${taxLabel} is added to this invoice.`
              : `No ${taxLabel} is charged on cash or e-transfer sales. The account must settle by that method — changing it later means cancelling and re-issuing.`}
          </p>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
            {busy ? "Creating…" : "Create draft invoice"}
          </button>
        </form>
      )}
    </section>
  );
}
