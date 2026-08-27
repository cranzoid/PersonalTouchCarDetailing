"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { createInvoiceFromAppointmentAction } from "../../invoices/actions";

/**
 * "Create invoice" for a visit that ended without a check-in.
 *
 * The invoice is built from what the appointment currently says, so this panel
 * deliberately has no line editor of its own. Changing what gets billed happens
 * one panel up, in "Change packages": that rewrites the booking AND the draft
 * invoice together (DECISIONS.md §21), which is why the appointment and the
 * bill can never drift apart. A second editor here would be a second source of
 * truth about what the customer bought.
 */
export function CreateInvoicePanel({
  appointmentId,
  lineCount,
  totalCents,
  depositPaidCents,
  currency,
}: {
  appointmentId: string;
  lineCount: number;
  totalCents: number;
  depositPaidCents: number;
  currency: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/admin/invoices/${res.invoiceId}`);
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-800 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Invoice</h2>
      <p className="mt-2 text-sm text-ink-300">
        Bills the {lineCount === 1 ? "service" : `${lineCount} services`} listed above —{" "}
        {formatCents(totalCents, currency)}.
        {depositPaidCents > 0
          ? ` The ${formatCents(depositPaidCents, currency)} deposit already taken is applied automatically.`
          : ""}
      </p>
      <p className="mt-2 text-xs text-ink-500">
        Customer upgraded, downgraded or added something at the counter? Use{" "}
        <span className="text-ink-300">Change packages</span> first — the invoice is built from what
        this appointment says, so correcting it here keeps the two in step.
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Raised with tax. Recording the payment as cash or e-transfer takes the tax off
        automatically — there is nothing to set here.
      </p>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Creating…" : "Create invoice"}
      </button>
    </section>
  );
}
