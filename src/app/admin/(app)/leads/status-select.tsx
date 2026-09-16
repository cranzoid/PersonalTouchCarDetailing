"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setLeadStatusAction, setQuoteRequestStatusAction } from "./actions";

/**
 * "Completed" means the work the lead asked for has been done — a first wash
 * redeemed at the counter sets it automatically. "Converted" is only ever set
 * by the conversion workflow, because it needs a linked customer.
 */
const LEAD_STATUSES = ["new", "contacted", "qualified", "completed", "lost"] as const;
const LINKED_LEAD_STATUSES = ["converted", "completed"] as const;
const QUOTE_STATUSES = ["new", "reviewing", "estimated", "closed"] as const;

export function LeadStatusSelect({
  leadId,
  status,
  linkedToCustomer = false,
}: {
  leadId: string;
  status: string;
  /** A lead with a customer can only be converted or completed. */
  linkedToCustomer?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const statuses: readonly string[] =
    linkedToCustomer || status === "converted" ? LINKED_LEAD_STATUSES : LEAD_STATUSES;
  return (
    <select
      value={status}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        await setLeadStatusAction({ leadId, status: e.target.value });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs capitalize text-ink-200"
    >
      {statuses.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

export function QuoteStatusSelect({ quoteRequestId, status }: { quoteRequestId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <select
      value={status}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        await setQuoteRequestStatusAction({ quoteRequestId, status: e.target.value });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs capitalize text-ink-200"
    >
      {QUOTE_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}
