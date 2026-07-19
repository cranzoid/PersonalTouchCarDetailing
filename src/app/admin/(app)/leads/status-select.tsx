"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setLeadStatusAction, setQuoteRequestStatusAction } from "./actions";

const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
const QUOTE_STATUSES = ["new", "reviewing", "estimated", "closed"] as const;

export function LeadStatusSelect({ leadId, status }: { leadId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
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
      {LEAD_STATUSES.map((s) => (
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
