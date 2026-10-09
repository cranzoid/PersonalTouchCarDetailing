"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HelcimCheckoutButton, type CheckoutConfirmResult, type CheckoutStartResult } from "@/components/helcim-checkout";
import type { PortalInvoice } from "@/lib/portal-invoices";

/**
 * Outstanding and paid invoices with tick-to-pay: the customer picks any of
 * the open ones and pays them together in one card payment, or tells us they
 * will pay by cheque or in person. The server re-reads every balance — the
 * total shown here is only a preview.
 */
export function InvoicePicker({
  invoices,
  currency,
  viewHref,
  startPayment,
  confirmPayment,
  setPayIntent,
}: {
  invoices: PortalInvoice[];
  currency: string;
  /** Link for one invoice's detail page; `{id}` is replaced. */
  viewHref: string;
  startPayment: (invoiceIds: string[]) => Promise<CheckoutStartResult>;
  confirmPayment: (checkoutId: string, eventMessage: string) => Promise<CheckoutConfirmResult>;
  setPayIntent?: (invoiceIds: string[], intent: "cheque" | "in_person") => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const open = invoices.filter((invoice) => invoice.balanceCents > 0);
  const settled = invoices.filter((invoice) => invoice.balanceCents <= 0);
  const payable = open.filter((invoice) => !invoice.blocker);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(payable.map((invoice) => invoice.id)));
  const [intentMessage, setIntentMessage] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalCents = useMemo(
    () => open.filter((invoice) => selected.has(invoice.id)).reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    [open, selected],
  );
  const money = (cents: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
  const selectedIds = [...selected];

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function promise(intent: "cheque" | "in_person") {
    if (!setPayIntent || selectedIds.length === 0) return;
    setBusy(true);
    setIntentError(null);
    const result = await setPayIntent(selectedIds, intent);
    setBusy(false);
    if (!result.ok) return setIntentError(result.error);
    setIntentMessage(
      intent === "cheque"
        ? "Thanks — we've noted that a cheque is on its way. The invoices will show as paid once it's received."
        : "Thanks — we've noted you'll pay in person. The invoices will show as paid once you do.",
    );
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {open.length > 0 ? (
        <fieldset className="rounded-2xl border border-ink-700/70 bg-ink-900/60 p-4 shadow-lg shadow-black/10 sm:p-5">
          <legend className="px-1 text-sm font-semibold text-white">Outstanding ({open.length})</legend>
          <ul className="mt-2 divide-y divide-ink-800">
            {open.map((invoice) => {
              const disabled = Boolean(invoice.blocker);
              return (
                <li key={invoice.id} className="flex flex-wrap items-center gap-3 py-3">
                  <input
                    id={`pick-${invoice.id}`}
                    type="checkbox"
                    className="h-5 w-5 rounded border-ink-600 bg-ink-950 accent-[#e0a93b]"
                    checked={selected.has(invoice.id)}
                    disabled={disabled}
                    onChange={() => toggle(invoice.id)}
                  />
                  <label htmlFor={`pick-${invoice.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block font-medium text-white">INV-{invoice.number}</span>
                    <span className="block text-xs text-ink-400">
                      {invoice.dateLabel}
                      {invoice.dueLabel ? ` · due ${invoice.dueLabel}` : ""}
                      {invoice.payIntent ? ` · you told us: ${invoice.payIntent === "cheque" ? "paying by cheque" : "paying in person"}` : ""}
                    </span>
                    {invoice.blocker && <span className="mt-1 block text-xs text-amber-300">{invoice.blocker}</span>}
                  </label>
                  <span className="text-right text-sm">
                    <span className="block font-semibold text-accent-300">{invoice.balanceLabel}</span>
                    <a href={viewHref.replace("{id}", invoice.id)} className="text-xs text-ink-400 underline-offset-4 hover:underline">
                      View
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 border-t border-ink-800 pt-4">
            <p className="text-sm text-ink-300">
              Selected: <strong className="text-white">{selectedIds.length}</strong> · Total{" "}
              <strong className="text-lg text-accent-300">{money(totalCents)}</strong>
            </p>
            <div className="mt-4">
              <HelcimCheckoutButton
                key={[...selectedIds].sort().join(",")}
                label={selectedIds.length > 1 ? `Pay ${selectedIds.length} invoices — ${money(totalCents)}` : `Pay ${money(totalCents)} by card`}
                start={() => startPayment(selectedIds)}
                confirm={confirmPayment}
                disabled={selectedIds.length === 0 || busy}
                successMessage="Payment received — thank you! Your receipt is on its way."
              />
            </div>
            {setPayIntent && (
              <div className="mt-5 rounded-xl border border-ink-700 bg-ink-950/40 p-4">
                <p className="text-sm text-ink-300">Paying another way? Let us know for the selected invoices:</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy || selectedIds.length === 0}
                    onClick={() => void promise("cheque")}
                    className="min-h-11 rounded-xl border border-ink-600 px-4 py-2 text-sm text-ink-100 hover:bg-ink-800 disabled:opacity-40"
                  >
                    We&apos;ll pay by cheque
                  </button>
                  <button
                    type="button"
                    disabled={busy || selectedIds.length === 0}
                    onClick={() => void promise("in_person")}
                    className="min-h-11 rounded-xl border border-ink-600 px-4 py-2 text-sm text-ink-100 hover:bg-ink-800 disabled:opacity-40"
                  >
                    We&apos;ll pay in person
                  </button>
                </div>
                {intentMessage && <p role="status" className="mt-3 text-sm text-emerald-300">{intentMessage}</p>}
                {intentError && <p role="alert" className="mt-3 text-sm text-red-300">{intentError}</p>}
              </div>
            )}
          </div>
        </fieldset>
      ) : (
        <p className="rounded-2xl border border-emerald-500/25 bg-emerald-950/20 p-5 text-sm text-emerald-300">
          Nothing outstanding — you&apos;re all paid up. Thank you!
        </p>
      )}

      {settled.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-ink-400">Paid ({settled.length})</h3>
          <ul className="mt-2 space-y-2">
            {settled.map((invoice) => (
              <li key={invoice.id}>
                <a
                  href={viewHref.replace("{id}", invoice.id)}
                  className="flex min-h-12 items-center justify-between rounded-2xl border border-ink-700/70 bg-ink-900/40 px-4 py-3 text-sm hover:border-accent-500/60"
                >
                  <span>
                    <span className="block font-medium text-white">INV-{invoice.number}</span>
                    <span className="text-xs text-ink-500">{invoice.dateLabel}</span>
                  </span>
                  <span className="text-ink-300">
                    {invoice.totalLabel} <span className="ml-2 text-xs capitalize text-emerald-300">{invoice.status.replaceAll("_", " ")}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
