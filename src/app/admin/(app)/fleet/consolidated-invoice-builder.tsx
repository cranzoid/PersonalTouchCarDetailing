"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
}: {
  customerId: string;
  jobs: EligibleFleetJob[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const jobIds = form.getAll("jobId").map(String);
    const result = await createConsolidatedInvoiceAction({ customerId, jobIds });
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
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
            {busy ? "Creating…" : "Create draft invoice"}
          </button>
        </form>
      )}
    </section>
  );
}
