"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { queueAudienceAction } from "../actions";
import { card, heading, label, primaryButton, secondaryButton, subtle } from "../ui";

export type AudienceRow = {
  appointmentId: string;
  customerId: string;
  name: string;
  destination: string;
  outcome: "cancelled" | "no_show";
  reason: string | null;
  missedOnLabel: string;
  services: string;
  total: string;
  footingLabel: string;
  blockedReason: string | null;
  alreadyContacted: boolean;
};

export type AudienceFilterValue = "missed" | "cancelled" | "no_show";

const FILTERS: { value: AudienceFilterValue; label: string }[] = [
  { value: "missed", label: "Both" },
  { value: "no_show", label: "No-shows" },
  { value: "cancelled", label: "Cancelled" },
];

const WINDOWS = [30, 90, 180, 365] as const;

const OUTCOME_STYLES: Record<string, string> = {
  no_show: "bg-[#F6E8E8] text-[#8B3F3F]",
  cancelled: "bg-[#FFF3D6] text-[#8A681F]",
};

/**
 * Picks the cancelled / no-show customers this campaign should go to.
 *
 * Filtering navigates rather than fetching, so the chosen window lives in the
 * URL and the list is rebuilt by the server on every change. That matters more
 * than it looks: the reason, the consent footing and the do-not-contact state
 * are all computed server-side, and a client-side cache of them would be a
 * cache of exactly the facts that must not go stale.
 */
export function AudiencePanel({
  campaignId,
  channel,
  rows,
  totals,
  filter,
  withinDays,
}: {
  campaignId: string;
  channel: "email" | "sms";
  rows: AudienceRow[];
  totals: { eligible: number; blocked: number; scanned: number };
  filter: AudienceFilterValue;
  withinDays: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    queued: number;
    duplicates: number;
    refused: { name: string; reason: string }[];
  } | null>(null);

  const selectable = useMemo(
    () => rows.filter((r) => !r.blockedReason && !r.alreadyContacted),
    [rows],
  );
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.appointmentId));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function go(next: { filter?: AudienceFilterValue; days?: number }) {
    const params = new URLSearchParams({
      audience: next.filter ?? filter,
      days: String(next.days ?? withinDays),
    });
    setSelected(new Set());
    router.push(`/admin/marketing/${campaignId}?${params.toString()}#audience`);
  }

  async function add() {
    setBusy(true);
    setError(null);
    setSummary(null);
    const result = await queueAudienceAction({
      campaignId,
      filter,
      withinDays,
      appointmentIds: [...selected],
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSummary({ queued: result.queued, duplicates: result.duplicates, refused: result.refused });
    setSelected(new Set());
    router.refresh();
  }

  return (
    <section id="audience" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={heading}>Who didn&rsquo;t come in</h2>
          <p className={`mt-1 ${subtle}`}>
            Everyone whose booking was cancelled or who never showed up, with the reason they gave —
            or a note that they gave none. Tick the ones you want on this campaign.
          </p>
        </div>
        <span className="rounded-full bg-[#EEF2F6] px-3 py-1 text-[11px] font-bold text-[#4C5F73]">
          {totals.eligible} can be messaged
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <p className={label}>Show</p>
          <div className="mt-1.5 flex gap-2">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => go({ filter: option.value })}
                className={`min-h-10 rounded-xl border px-3.5 text-xs font-semibold transition ${
                  filter === option.value
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-white admin-on-dark"
                    : "border-[#D5DEE7] bg-white text-[#42536A] hover:border-[#0B2A4A]/30"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className={label}>Going back</p>
          <div className="mt-1.5 flex gap-2">
            {WINDOWS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => go({ days })}
                className={`min-h-10 rounded-xl border px-3.5 text-xs font-semibold transition ${
                  withinDays === days
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-white admin-on-dark"
                    : "border-[#D5DEE7] bg-white text-[#42536A] hover:border-[#0B2A4A]/30"
                }`}
              >
                {days === 365 ? "1 year" : `${days} days`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-5 rounded-xl bg-[#F6F8FA] px-4 py-10 text-center text-sm text-[#5A6B7D]">
          Nobody cancelled or missed an appointment in this window. Try a longer one.
        </p>
      ) : (
        <>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                <tr>
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select everyone who can be messaged"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(selectable.map((r) => r.appointmentId))
                            : new Set(),
                        )
                      }
                      className="h-4 w-4"
                    />
                  </th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">What happened</th>
                  <th className="py-2 pr-3 font-semibold">Reason</th>
                  <th className="py-2 pr-3 font-semibold">Booking</th>
                  <th className="py-2 font-semibold">{channel === "sms" ? "Mobile" : "Email"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EBF0F5]">
                {rows.map((row) => {
                  const disabled = Boolean(row.blockedReason) || row.alreadyContacted;
                  return (
                    <tr key={row.appointmentId} className={disabled ? "opacity-60" : undefined}>
                      <td className="py-3 align-top">
                        <input
                          type="checkbox"
                          aria-label={`Add ${row.name}`}
                          checked={selected.has(row.appointmentId)}
                          disabled={disabled}
                          onChange={() => toggle(row.appointmentId)}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="py-3 pr-3 align-top">
                        <Link
                          href={`/admin/customers/${row.customerId}`}
                          className="font-semibold text-[#0B2A4A] hover:underline"
                        >
                          {row.name}
                        </Link>
                        <span className="block text-[11px] text-[#5A6B7D]">{row.footingLabel}</span>
                      </td>
                      <td className="py-3 pr-3 align-top">
                        <span
                          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${OUTCOME_STYLES[row.outcome]}`}
                        >
                          {row.outcome === "no_show" ? "No-show" : "Cancelled"}
                        </span>
                        <span className="mt-1 block text-[11px] text-[#5A6B7D]">{row.missedOnLabel}</span>
                      </td>
                      <td className="py-3 pr-3 align-top text-[#25313F]">
                        {row.reason ?? (
                          <span className="italic text-[#5A6B7D]">No reason recorded</span>
                        )}
                      </td>
                      <td className="py-3 pr-3 align-top text-[#42536A]">
                        <Link
                          href={`/admin/appointments/${row.appointmentId}`}
                          className="hover:underline"
                        >
                          {row.services || "—"}
                        </Link>
                        <span className="block text-[11px] text-[#5A6B7D]">{row.total}</span>
                      </td>
                      <td className="py-3 align-top text-[#42536A]">
                        {row.destination || <span className="italic text-[#5A6B7D]">none</span>}
                        {row.blockedReason && (
                          <span className="mt-1 block text-[11px] font-semibold text-[#8B3F3F]">
                            {row.blockedReason}
                          </span>
                        )}
                        {!row.blockedReason && row.alreadyContacted && (
                          <span className="mt-1 block text-[11px] font-semibold text-[#5C4A78]">
                            Already messaged in a campaign
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => void add()}
              className={primaryButton}
            >
              {busy ? "Adding…" : `Add ${selected.size || ""} to this campaign`.replace("  ", " ")}
            </button>
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())} className={secondaryButton}>
                Clear
              </button>
            )}
            {error && <span className="text-sm text-[#8B3F3F]">{error}</span>}
          </div>

          {totals.blocked > 0 && (
            <p className="mt-3 text-[11px] leading-5 text-[#5A6B7D]">
              {totals.blocked} {totals.blocked === 1 ? "person is" : "people are"} shown but cannot be
              ticked — no {channel === "sms" ? "number" : "email address"} on file, already opted
              out, or too long ago to contact without asking them first.
            </p>
          )}

          {summary && (
            <div className="mt-4 rounded-xl border border-[#CFE3D6] bg-[#F2F9F4] p-4 text-sm text-[#25313F]">
              <p className="font-semibold text-[#2C6B45]">
                Added {summary.queued} {summary.queued === 1 ? "contact" : "contacts"}.
              </p>
              {summary.duplicates > 0 && (
                <p className="mt-1 text-[#42536A]">
                  {summary.duplicates} already on this campaign — they are only ever messaged once.
                </p>
              )}
              {summary.refused.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[#8B3F3F]">
                  {summary.refused.map((r, i) => (
                    <li key={`${r.name}-${i}`}>
                      {r.name}: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
