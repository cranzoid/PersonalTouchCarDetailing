"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setLeadStatusAction } from "./actions";

/**
 * The one status a lead has. It is shown on the Leads list, the lead's page and
 * its call log, and the lead's quote or callback requests follow it.
 *
 * "Completed" means the work the lead asked for has been done — a first wash
 * redeemed at the counter sets it automatically. "Converted" is only ever set
 * by the conversion workflow, because it needs a linked customer.
 */
const LEAD_STATUSES = ["new", "contacted", "qualified", "completed", "lost"] as const;
const LINKED_LEAD_STATUSES = ["converted", "completed"] as const;

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
  const [error, setError] = useState<string | null>(null);
  const allowed: readonly string[] =
    linkedToCustomer || status === "converted" ? LINKED_LEAD_STATUSES : LEAD_STATUSES;
  // An estimate marks its lead qualified while also linking a customer, so the
  // current status may sit outside the list it can move to. Show it anyway
  // rather than have the box claim a status the lead does not have.
  const statuses = allowed.includes(status) ? allowed : [status, ...allowed];
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <select
        aria-label="Lead status"
        value={status}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          setError(null);
          const result = await setLeadStatusAction({ leadId, status: e.target.value });
          setBusy(false);
          if (!result.ok) setError(result.error);
          router.refresh();
        }}
        className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs capitalize text-ink-200"
      >
        {statuses.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      {error && <span className="text-xs text-red-300">{error}</span>}
    </span>
  );
}
