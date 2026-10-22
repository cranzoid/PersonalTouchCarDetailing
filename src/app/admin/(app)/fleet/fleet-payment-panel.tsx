"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { PAYMENT_METHOD_TAXABLE, type ManualPaymentMethod } from "@/lib/types";
import { recordFleetPaymentAction } from "../invoices/actions";

export type OpenFleetInvoice = {
  id: string;
  number: number;
  status: string;
  dueLabel: string | null;
  /** Owing if the tax stands (card, cheque, or already settled). */
  balanceCents: number;
  /** Owing if this payment strips the tax (cash / e-transfer on an unsettled invoice). */
  untaxedBalanceCents: number;
  /** True once a payment or a staff exemption has fixed the tax treatment. */
  taxSettled: boolean;
  /**
   * Set once a payment method has fixed the tax: true = taxed, false = untaxed.
   * Null when nothing binds it (unpaid, or exempted by staff), so any method works.
   */
  settledTaxable: boolean | null;
};

const PAYMENT_METHODS: { value: ManualPaymentMethod; label: string }[] = [
  { value: "cheque", label: "Cheque" },
  { value: "etransfer", label: "E-transfer" },
  { value: "cash", label: "Cash" },
  { value: "card_terminal", label: "Card terminal" },
];

function newBatchKey(): string {
  return `fleetpay_${globalThis.crypto.randomUUID()}`;
}

export function FleetPaymentPanel({
  customerId,
  invoices,
  currency,
  taxLabel,
}: {
  customerId: string;
  invoices: OpenFleetInvoice[];
  currency: string;
  taxLabel: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<ManualPaymentMethod>("cheque");
  const [reference, setReference] = useState("");
  const [sendReceipts, setSendReceipts] = useState(false);
  const [batchKey, setBatchKey] = useState(newBatchKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const methodTaxable = PAYMENT_METHOD_TAXABLE[method];
  // Mirrors resolvePaymentTax: an invoice part-paid one way cannot take the
  // other, and an unsettled one owes the untaxed figure for cash/e-transfer.
  const rows = useMemo(
    () =>
      invoices.map((invoice) => ({
        ...invoice,
        blocked: invoice.settledTaxable !== null && invoice.settledTaxable !== methodTaxable,
        dueCents: !invoice.taxSettled && !methodTaxable ? invoice.untaxedBalanceCents : invoice.balanceCents,
      })),
    [invoices, methodTaxable],
  );
  const payable = rows.filter((row) => !row.blocked);
  const chosen = payable.filter((row) => selected.has(row.id));
  const totalCents = chosen.reduce((sum, row) => sum + row.dueCents, 0);
  const strippedCents = chosen.reduce((sum, row) => sum + (row.balanceCents - row.dueCents), 0);
  const allChosen = payable.length > 0 && chosen.length === payable.length;

  function toggle(id: string) {
    setDone(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectWhere(predicate: (row: (typeof rows)[number]) => boolean) {
    setDone(null);
    setSelected(new Set(payable.filter(predicate).map((row) => row.id)));
  }

  async function submit() {
    if (chosen.length === 0) return setError("Choose at least one invoice");
    setBusy(true);
    setError(null);
    const res = await recordFleetPaymentAction({
      customerId,
      invoiceIds: chosen.map((row) => row.id),
      method,
      reference: reference.trim() || undefined,
      sendReceipts,
      idempotencyKey: batchKey,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDone(`${res.invoiceCount} invoice${res.invoiceCount === 1 ? "" : "s"} marked paid — ${formatCents(res.totalCents, currency)} recorded.`);
    setSelected(new Set());
    setReference("");
    setBatchKey(newBatchKey());
    router.refresh();
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-800 p-5">
      <h2 className="text-lg font-semibold text-white">Record a payment for several invoices</h2>
      <p className="mt-1 text-sm text-ink-400">
        For one cheque or transfer covering several bills. Each invoice you tick is paid in full and shows as paid here,
        on the invoice, and on the customer&apos;s portal.
      </p>

      {done && <p className="mt-4 text-sm text-emerald-300">{done}</p>}

      {invoices.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">Nothing is owing on this account.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <button type="button" onClick={() => selectWhere(() => !allChosen)} className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-200 hover:border-accent-500/60">
              {allChosen ? "Clear selection" : "Select all"}
            </button>
            <button type="button" onClick={() => selectWhere((row) => row.status === "overdue")} className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-200 hover:border-accent-500/60">
              Select overdue only
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {rows.map((row) => (
              <label
                key={row.id}
                className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${
                  row.blocked ? "cursor-not-allowed border-ink-800 opacity-60" : "cursor-pointer border-ink-800 hover:border-accent-500/50"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent-400"
                  disabled={row.blocked || busy}
                  checked={!row.blocked && selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-white">INV-{row.number}</span>
                  <span className="block text-xs text-ink-500">
                    {row.dueLabel ? `Due ${row.dueLabel}` : "No due date"}
                    {row.blocked && ` · already part-paid ${row.settledTaxable ? `with ${taxLabel}` : `without ${taxLabel}`}, so it can't take this method — record it on the invoice`}
                  </span>
                </span>
                <StatusBadge status={row.status} />
                <span className="w-24 text-right text-ink-200">{formatCents(row.dueCents, currency)}</span>
              </label>
            ))}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-ink-300">
              Paid by
              <select
                value={method}
                onChange={(event) => { setMethod(event.target.value as ManualPaymentMethod); setDone(null); }}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-white"
              >
                {PAYMENT_METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-sm text-ink-300">
              {method === "cheque" ? "Cheque number" : "Reference"} <span className="text-ink-500">(optional)</span>
              <input
                value={reference}
                maxLength={100}
                onChange={(event) => setReference(event.target.value)}
                placeholder={method === "cheque" ? "e.g. 004512" : "e.g. transfer confirmation"}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-white"
              />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" className="h-4 w-4 accent-accent-400" checked={sendReceipts} onChange={(event) => setSendReceipts(event.target.checked)} />
            Send the customer a receipt for each invoice
          </label>

          <div className="mt-5 rounded-lg border border-ink-800 bg-ink-900/50 p-4 text-sm">
            <p className="text-white">
              {chosen.length} invoice{chosen.length === 1 ? "" : "s"} selected · <span className="font-semibold">{formatCents(totalCents, currency)}</span> to record
            </p>
            {strippedCents > 0 && (
              <p className="mt-1 text-xs text-amber-300">
                {method === "cash" ? "Cash" : "E-transfer"} carries no {taxLabel}: {formatCents(strippedCents, currency)} of {taxLabel} comes off these invoices.
              </p>
            )}
          </div>

          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button
            type="button"
            onClick={submit}
            disabled={busy || chosen.length === 0}
            className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50"
          >
            {busy ? "Recording…" : chosen.length === 0 ? "Mark paid" : `Mark ${chosen.length} invoice${chosen.length === 1 ? "" : "s"} paid`}
          </button>
        </>
      )}
    </section>
  );
}
