"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInvoiceFromJobAction } from "../../invoices/actions";

/** Turns a ready-for-pickup/completed job into a draft invoice and opens it. */
export function CreateInvoiceButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await createInvoiceFromJobAction({ jobId });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.push(`/admin/invoices/${res.invoiceId}`);
  }

  return (
    <div>
      <button
        disabled={busy}
        onClick={() => void run()}
        className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create Invoice"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
