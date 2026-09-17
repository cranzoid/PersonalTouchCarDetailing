"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { renderOutreachBody, smsSegments, unknownMergeFields } from "@/lib/marketing/message";
import {
  MAX_WINBACK_BATCH,
  WINBACK_LIMITS,
  WINBACK_PLACEHOLDERS,
} from "@/lib/marketing/winback-message";
import { matchesSearch } from "@/lib/option-search";
import { card, heading, input, label, primaryButton, secondaryButton, subtle, textarea } from "./ui";
import { saveWinbackWordingAction, sendWinbackAction, sendWinbackTestAction } from "./actions";

export type OutreachHistoryItem = {
  id: string;
  atLabel: string;
  channel: string;
  label: string;
  status: string;
  subject: string | null;
  preview: string;
  staffName: string | null;
};

export type OutreachRow = {
  appointmentId: string;
  customerId: string;
  /** "Dave · Hamilton Plumbing" — what the list is read by. */
  name: string;
  firstName: string;
  companyName: string;
  phone: string | null;
  email: string | null;
  outcome: "cancelled" | "no_show";
  reason: string | null;
  missedOnLabel: string;
  services: string;
  total: string;
  footingLabel: string;
  /** Why this person cannot be texted / emailed right now, or null. */
  blockedSms: string | null;
  blockedEmail: string | null;
  /** An earlier send already reached them on this channel. */
  contactedSms: boolean;
  contactedEmail: boolean;
  history: OutreachHistoryItem[];
};

type Channel = "sms" | "email";

type Outcome = {
  appointmentId: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

type Filter = "new" | "no_show" | "cancelled" | "contacted" | "all";

const WINDOWS = [30, 90, 180, 365] as const;

const OUTCOME_TONES: Record<Outcome["status"], string> = {
  sent: "text-emerald-700",
  skipped: "text-[#8A681F]",
  failed: "text-red-700",
};

const OUTCOME_BADGES: Record<OutreachRow["outcome"], { label: string; tone: string }> = {
  no_show: { label: "No-show", tone: "bg-[#F6E8E8] text-[#8B3F3F]" },
  cancelled: { label: "Cancelled", tone: "bg-[#FFF3D6] text-[#8A681F]" },
};

/**
 * Outreach, as one screen.
 *
 * Built to the shape of the first-wash nudge workspace, because that is the one
 * the shop actually uses: the people on the left, the message on the right, and
 * the send button next to the list of who it is about to reach. The old flow
 * asked for a campaign, an audience, a queue and then batches — four screens to
 * say "text these nine people".
 *
 * The channel toggle does not reload: each row arrives carrying both its text
 * and its email verdict, so switching between them greys the right rows out
 * immediately. Only "how far back" costs a round trip, because that is the one
 * control that changes which rows exist.
 */
export function OutreachWorkspace({
  rows,
  withinDays,
  totals,
  businessName,
  sendWindow,
  providerReady,
  templates,
  recentSends,
}: {
  rows: OutreachRow[];
  withinDays: number;
  totals: {
    scanned: number;
    sms: { eligible: number; blocked: number };
    email: { eligible: number; blocked: number };
  };
  businessName: string;
  sendWindow: { allowed: boolean; localHour: number };
  providerReady: { sms: boolean; email: boolean };
  templates: { sms: string; emailSubject: string; emailBody: string };
  recentSends: {
    id: string;
    name: string;
    channel: string;
    status: string;
    people: number;
    atLabel: string;
  }[];
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>("sms");
  const [filter, setFilter] = useState<Filter>("new");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [smsBody, setSmsBody] = useState(templates.sms);
  const [emailSubject, setEmailSubject] = useState(templates.emailSubject);
  const [emailBody, setEmailBody] = useState(templates.emailBody);
  const [focusField, setFocusField] = useState<"subject" | "body">("body");
  const [allowRecontact, setAllowRecontact] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "send" | "save" | "test">(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [testTo, setTestTo] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const body = channel === "sms" ? smsBody : emailBody;
  const setBody = channel === "sms" ? setSmsBody : setEmailBody;
  const subject = channel === "email" ? emailSubject : "";
  const blockedFor = (row: OutreachRow) => (channel === "sms" ? row.blockedSms : row.blockedEmail);
  const contactedOn = (row: OutreachRow) => (channel === "sms" ? row.contactedSms : row.contactedEmail);

  // "Already messaged" is only a blocker while the follow-up box is unticked —
  // that box is how the owner says they mean it this time.
  const heldFor = (row: OutreachRow): string | null =>
    blockedFor(row) ?? (contactedOn(row) && !allowRecontact ? "Already messaged in an earlier send" : null);

  const FILTERS: { key: Filter; label: string; test: (row: OutreachRow) => boolean }[] = useMemo(
    () => [
      { key: "new", label: "Not messaged yet", test: (r) => !blockedFor(r) && !contactedOn(r) },
      { key: "no_show", label: "No-shows", test: (r) => r.outcome === "no_show" },
      { key: "cancelled", label: "Cancelled", test: (r) => r.outcome === "cancelled" },
      { key: "contacted", label: "Already messaged", test: (r) => contactedOn(r) },
      { key: "all", label: "Everyone", test: () => true },
    ],
    // Recomputed per channel: whether a row counts as "not messaged yet"
    // depends on which channel is being sent on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel],
  );

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(f.test).length])) as Record<Filter, number>,
    [rows, FILTERS],
  );
  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    return rows.filter(
      (row) =>
        test(row) &&
        (!query.trim() ||
          matchesSearch(
            [row.name, row.phone, row.email, row.services, row.reason].filter(Boolean).join(" "),
            query,
          )),
    );
  }, [rows, filter, query, FILTERS]);

  const selectedRows = rows.filter((row) => selected.has(row.appointmentId));
  const sendable = selectedRows.filter((row) => !heldFor(row));
  const heldBack = selectedRows.length - sendable.length;

  const sample = sendable[0] ?? selectedRows[0];
  const previewValues = {
    firstName: sample?.firstName || "Dave",
    companyName: sample?.companyName || "Hamilton Plumbing",
    lastVisit: sample?.missedOnLabel || "12 Aug 2026",
  };
  const renderedSubject = renderOutreachBody(subject, previewValues);
  const renderedBody = renderOutreachBody(body, previewValues);
  const unknown = [...new Set([...unknownMergeFields(body), ...unknownMergeFields(subject)])];
  const issues = checkCampaignCompliance({
    channel,
    subject: channel === "email" ? renderedSubject : null,
    body: renderedBody,
    businessName,
  });
  const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
  if (unknown.length > 0) {
    errors.unshift(
      `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}`,
    );
  }
  if (channel === "sms" && body.length > WINBACK_LIMITS.smsBody) {
    errors.push(`Texts are limited to ${WINBACK_LIMITS.smsBody} characters.`);
  }
  const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);
  const segments = channel === "sms" ? smsSegments(renderedBody) : null;

  const sendBlocker = !providerReady[channel]
    ? channel === "sms"
      ? "Twilio is not configured (Settings → Integrations)."
      : "Email sending is not configured (Settings → Integrations)."
    : !sendWindow.allowed
      ? `It is ${sendWindow.localHour}:00 — outreach only goes out between 9am and 8pm.`
      : errors.length > 0
        ? "Fix the message first."
        : sendable.length === 0
          ? "Tick the people to message."
          : null;

  function switchChannel(next: Channel) {
    setChannel(next);
    setConfirming(false);
    setFocusField("body");
  }

  function toggle(id: string) {
    setConfirming(false);
    if (!selected.has(id) && selected.size >= MAX_WINBACK_BATCH) {
      setNotice({
        ok: false,
        text: `Up to ${MAX_WINBACK_BATCH} people at a time — send these, then pick the next ones.`,
      });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectVisible() {
    setConfirming(false);
    setSelected(
      new Set(
        visible
          .filter((row) => !heldFor(row))
          .slice(0, MAX_WINBACK_BATCH)
          .map((row) => row.appointmentId),
      ),
    );
  }

  function toggleHistory(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Drops `{{Key}}` in at the cursor of whichever field was last focused. */
  function insertPlaceholder(key: string) {
    const token = `{{${key}}}`;
    const useSubject = channel === "email" && focusField === "subject";
    const element = useSubject ? subjectRef.current : bodyRef.current;
    const current = useSubject ? emailSubject : body;
    const start = element?.selectionStart ?? current.length;
    const end = element?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    if (useSubject) setEmailSubject(next);
    else setBody(next);
    setConfirming(false);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function send() {
    setBusy("send");
    setNotice(null);
    const result = await sendWinbackAction({
      appointmentIds: sendable.map((row) => row.appointmentId),
      // Both outcomes are on the page and the tabs filter them here, so the
      // server re-check has to look at the same list this selection came from.
      filter: "missed",
      withinDays,
      channel,
      subject,
      body,
      allowRecontact,
      // The compliance warnings are already on screen above the button; the
      // confirm step is where they were acknowledged.
      acknowledgeWarnings: true,
    });
    setBusy(null);
    setConfirming(false);
    if (!result.ok) {
      setNotice({ ok: false, text: result.error });
      return;
    }
    setOutcomes(result.outcomes);
    const parts = [`${result.sent} sent`];
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    if (result.failed) parts.push(`${result.failed} failed`);
    setNotice({ ok: result.failed === 0 && result.sent > 0, text: parts.join(", ") });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const outcome of result.outcomes) if (outcome.status === "sent") next.delete(outcome.appointmentId);
      return next;
    });
    router.refresh();
  }

  async function save() {
    setBusy("save");
    setNotice(null);
    const result = await saveWinbackWordingAction({ channel, subject, body });
    setBusy(null);
    setNotice(
      result.ok
        ? {
            ok: true,
            text: `Saved. The ${channel === "sms" ? "text" : "email"} will open with this wording next time.`,
          }
        : { ok: false, text: result.error },
    );
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    const result = await sendWinbackTestAction({ channel, subject, body, destination: testTo });
    setBusy(null);
    setNotice(
      result.ok
        ? { ok: true, text: `Test sent to ${testTo}, filled in with sample details.` }
        : { ok: false, text: result.detail ? `${result.error} ${result.detail}` : result.error },
    );
  }

  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {(
          [
            ["Missed bookings", totals.scanned],
            ["Can be texted", totals.sms.eligible],
            ["Can be emailed", totals.email.eligible],
            ["Not messaged yet", counts.new],
            ["Already messaged", counts.contacted],
          ] as const
        ).map(([title, value]) => (
          <div key={title} className={card}>
            <p className={subtle}>{title}</p>
            <p className="mt-1 text-2xl font-bold text-[#0B2A4A]">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className={`min-w-0 ${card}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>People</h2>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectVisible} className={`${secondaryButton} min-h-9 px-3 text-xs`}>
                Select {channel === "sms" ? "textable" : "emailable"} in view (max {MAX_WINBACK_BATCH})
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSelected(new Set());
                    setConfirming(false);
                  }}
                  className={`${secondaryButton} min-h-9 px-3 text-xs`}
                >
                  Clear ({selected.size})
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  filter === f.key
                    ? "bg-[#0B2A4A] text-white admin-on-dark"
                    : "bg-[#EEF2F6] text-[#42536A] hover:bg-[#E2E8EF]"
                }`}
              >
                {f.label} <span className="opacity-70">{counts[f.key]}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-[14rem] flex-1">
              <span className="sr-only">Search</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, phone, email, service or reason"
                className={input}
              />
            </label>
            <div>
              <p className={label}>Going back</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {WINDOWS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => {
                      setSelected(new Set());
                      setConfirming(false);
                      router.push(`/admin/marketing?days=${days}`, { scroll: false });
                    }}
                    className={`min-h-9 rounded-xl border px-3 text-xs font-semibold transition ${
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

          {visible.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#F6F8FA] px-4 py-10 text-center text-sm text-[#5A6B7D]">
              {query.trim()
                ? "Nobody here matches that search."
                : "Nobody here. Try a longer window, or another filter."}
            </p>
          ) : (
            <div className="relative mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-9" />
                  <col />
                  <col className="w-[34%]" />
                  <col className="w-[24%]" />
                </colgroup>
                <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                  <tr>
                    <th className="py-2 pr-2 font-semibold">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="py-2 pr-3 font-semibold">Customer</th>
                    <th className="py-2 pr-3 font-semibold">What happened</th>
                    <th className="py-2 font-semibold">Booking</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EBF0F5]">
                  {visible.map((row) => {
                    const held = heldFor(row);
                    const isSelected = selected.has(row.appointmentId);
                    const isOpen = expanded.has(row.appointmentId);
                    const badge = OUTCOME_BADGES[row.outcome];
                    return (
                      <Fragment key={row.appointmentId}>
                        <tr className={`align-top ${isSelected ? "bg-[#FBF6EC]" : ""}`}>
                          <td className="py-3 pr-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 disabled:opacity-30"
                              checked={isSelected}
                              disabled={Boolean(held) && !isSelected}
                              onChange={() => toggle(row.appointmentId)}
                              aria-label={`Select ${row.name}`}
                            />
                          </td>
                          <td className="break-words py-3 pr-3">
                            <Link
                              href={`/admin/customers/${row.customerId}`}
                              className="font-semibold text-[#0B2A4A] hover:underline"
                            >
                              {row.name}
                            </Link>
                            {row.phone && <span className="mt-0.5 block text-xs text-[#5A6B7D]">{row.phone}</span>}
                            {row.email && <span className="block break-all text-xs text-[#5A6B7D]">{row.email}</span>}
                            <span className="mt-0.5 block text-[11px] text-[#8592A0]">{row.footingLabel}</span>
                            {held && (
                              <span
                                className={`mt-1 block text-[11px] font-semibold ${
                                  isSelected ? "text-red-700" : "text-[#8592A0]"
                                }`}
                              >
                                {isSelected ? `Will be skipped — ${held.toLowerCase()}` : held}
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.tone}`}>
                              {badge.label}
                            </span>
                            <span className="mt-1 block text-[11px] text-[#5A6B7D]">{row.missedOnLabel}</span>
                            <span className="mt-1 block text-xs text-[#25313F]">
                              {row.reason ?? <span className="italic text-[#5A6B7D]">No reason recorded</span>}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleHistory(row.appointmentId)}
                              aria-expanded={isOpen}
                              className="-ml-2 mt-1 rounded-lg px-2 py-1 text-xs font-semibold text-[#8A681F] hover:bg-[#FBF6EC]"
                            >
                              {isOpen ? "Hide messages" : `Messages (${row.history.length})`}
                            </button>
                          </td>
                          <td className="py-3 text-xs text-[#42536A]">
                            <Link
                              href={`/admin/appointments/${row.appointmentId}`}
                              className="font-medium text-[#0B2A4A] hover:underline"
                            >
                              {row.services || "—"}
                            </Link>
                            <span className="mt-0.5 block text-[11px] text-[#8592A0]">{row.total}</span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td />
                            <td colSpan={3} className="pb-4">
                              <History items={row.history} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {recentSends.length > 0 && (
            <div className="mt-6 border-t border-[#E4EAF0] pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-[#8494A5]">Recent sends</h3>
              <ul className="mt-2 space-y-1.5">
                {recentSends.map((campaign) => (
                  <li key={campaign.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <Link
                      href={`/admin/marketing/${campaign.id}`}
                      className="font-semibold text-[#0B2A4A] hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <span className="text-[#5A6B7D]">
                      {campaign.people} {campaign.people === 1 ? "person" : "people"} · {campaign.status} ·{" "}
                      {campaign.atLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="xl:sticky xl:top-24 xl:self-start">
          <section className={card}>
            <h2 className={heading}>Message</h2>

            <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-[#EEF2F6] p-1" role="tablist" aria-label="Channel">
              {(["sms", "email"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={channel === option}
                  onClick={() => switchChannel(option)}
                  className={`min-h-9 rounded-lg text-sm font-semibold transition ${
                    channel === option ? "bg-white text-[#0B2A4A] shadow-sm" : "text-[#5A6B7D] hover:text-[#0B2A4A]"
                  }`}
                >
                  {option === "sms" ? "Text message" : "Email"}
                </button>
              ))}
            </div>

            {channel === "email" && (
              <label className={`mt-4 block ${label}`}>
                Subject
                <input
                  ref={subjectRef}
                  value={emailSubject}
                  maxLength={WINBACK_LIMITS.emailSubject}
                  onFocus={() => setFocusField("subject")}
                  onChange={(event) => {
                    setEmailSubject(event.target.value);
                    setConfirming(false);
                  }}
                  className={input}
                />
              </label>
            )}

            <label className={`mt-4 block ${label}`}>
              {channel === "sms" ? "Text" : "Email body"}
              <textarea
                ref={bodyRef}
                value={body}
                rows={channel === "sms" ? 6 : 12}
                onFocus={() => setFocusField("body")}
                onChange={(event) => {
                  setBody(event.target.value);
                  setConfirming(false);
                }}
                className={textarea}
              />
            </label>

            <div className="mt-2">
              <p className="text-[11px] text-[#5A6B7D]">Click to insert — each is filled in per person:</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {WINBACK_PLACEHOLDERS.map((placeholder) => (
                  <button
                    key={placeholder.key}
                    type="button"
                    title={placeholder.hint}
                    onClick={() => insertPlaceholder(placeholder.key)}
                    className="rounded-md border border-[#D5DEE7] bg-[#F9FBFC] px-2 py-1 font-mono text-[11px] text-[#0B2A4A] hover:border-[#E0A93B] hover:bg-[#FBF6EC]"
                  >
                    {`{{${placeholder.key}}}`}
                  </button>
                ))}
              </div>
            </div>

            {segments && (
              <p className="mt-3 text-[11px] text-[#5A6B7D]">
                {segments.characters} characters · {segments.segments} SMS segment
                {segments.segments === 1 ? "" : "s"} per person ({segments.encoding})
                {segments.nonGsmCharacters.length > 0 && (
                  <span className="block text-[#8A681F]">
                    {segments.nonGsmCharacters.map((c) => `“${c}”`).join(" ")} make
                    {segments.nonGsmCharacters.length === 1 ? "s" : ""} every segment shorter — swap for plain
                    characters to save money.
                  </span>
                )}
              </p>
            )}
            {channel === "email" && (
              <p className="mt-3 text-[11px] text-[#5A6B7D]">
                Your address and an unsubscribe link are added to the bottom automatically.
              </p>
            )}

            {errors.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {errors.map((message) => (
                  <li
                    key={message}
                    className="rounded-lg border border-[#E7C0C0] bg-[#FDF4F4] px-3 py-2 text-xs text-[#8B3F3F]"
                  >
                    {message}
                  </li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {warnings.map((message) => (
                  <li
                    key={message}
                    className="rounded-lg border border-[#E7C878] bg-[#FFF9E9] px-3 py-2 text-xs text-[#7A5F1E]"
                  >
                    {message}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8494A5]">
                Preview — {sample ? sample.name : "sample customer"}
              </p>
              {channel === "email" && <p className="mt-1.5 text-sm font-semibold text-[#0B2A4A]">{renderedSubject}</p>}
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-[#25313F]">{renderedBody}</p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null || errors.length > 0}
                onClick={save}
                className={`${secondaryButton} min-h-10 px-3 text-xs`}
              >
                {busy === "save" ? "Saving…" : "Save as default wording"}
              </button>
            </div>

            <label className="mt-4 flex items-start gap-2.5 text-xs text-[#42536A]">
              <input
                type="checkbox"
                checked={allowRecontact}
                onChange={(event) => {
                  setAllowRecontact(event.target.checked);
                  setConfirming(false);
                }}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Include people an earlier send already reached
                <span className="block text-[11px] text-[#8494A5]">
                  Off by default. Leave it off unless you mean to follow up with people you have already
                  messaged.
                </span>
              </span>
            </label>

            <div className="mt-5 border-t border-[#E4EAF0] pt-4">
              <p className="text-sm font-semibold text-[#0B2A4A]">
                {sendable.length} {sendable.length === 1 ? "person" : "people"} selected
              </p>
              {heldBack > 0 && (
                <p className="mt-0.5 text-xs text-[#8A681F]">
                  {heldBack} more ticked but cannot get {channel === "sms" ? "a text" : "an email"} right now —
                  they will be left out.
                </p>
              )}
              {sendBlocker && <p className="mt-1 text-xs text-[#5A6B7D]">{sendBlocker}</p>}

              {!confirming ? (
                <button
                  type="button"
                  disabled={Boolean(sendBlocker) || busy !== null}
                  onClick={() => setConfirming(true)}
                  className={`${primaryButton} mt-3 w-full`}
                >
                  Send {channel === "sms" ? "text" : "email"} to {sendable.length}{" "}
                  {sendable.length === 1 ? "person" : "people"}
                </button>
              ) : (
                <div className="mt-3 rounded-xl border border-[#E0A93B]/60 bg-[#FBF6EC] p-3">
                  <p className="text-sm text-[#42536A]">
                    Send this {channel === "sms" ? "text" : "email"} to {sendable.map((row) => row.name).join(", ")}{" "}
                    now?
                  </p>
                  {warnings.length > 0 && (
                    <p className="mt-1.5 text-xs font-semibold text-[#7A5F1E]">
                      Sending confirms you have read the warning above.
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null || Boolean(sendBlocker)}
                      onClick={send}
                      className={`${primaryButton} flex-1`}
                    >
                      {busy === "send" ? "Sending…" : "Yes, send now"}
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className={secondaryButton}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {notice && (
              <p
                role="status"
                aria-live="polite"
                className={`mt-3 rounded-xl border p-3 text-sm ${
                  notice.ok
                    ? "border-emerald-700/30 bg-emerald-50 text-emerald-800"
                    : "border-red-300 bg-red-50 text-red-800"
                }`}
              >
                {notice.text}
              </p>
            )}

            {outcomes && outcomes.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-3 text-xs">
                {outcomes.map((outcome) => (
                  <li key={outcome.appointmentId} className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium text-[#25313F]">{outcome.name}</span>
                    <span className={OUTCOME_TONES[outcome.status]}>
                      {outcome.status}
                      {outcome.reason ? ` — ${outcome.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 border-t border-[#E4EAF0] pt-4">
              <label className={label}>
                Send yourself a test first
                <input
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                  placeholder={channel === "sms" ? "Your mobile number" : "Your email address"}
                  className={input}
                />
              </label>
              <button
                type="button"
                disabled={busy !== null || testTo.trim().length < 3 || errors.length > 0}
                onClick={test}
                className={`${secondaryButton} mt-2 min-h-10 w-full text-xs`}
              >
                {busy === "test" ? "Sending test…" : "Send test"}
              </button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function History({ items }: { items: OutreachHistoryItem[] }) {
  if (items.length === 0) {
    return <p className="rounded-xl bg-[#F6F8FA] px-3 py-3 text-xs text-[#5A6B7D]">Nothing sent or received yet.</p>;
  }
  return (
    <ol className="space-y-2 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-3">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#5A6B7D]">
            <span className="font-semibold uppercase text-[#0B2A4A]">{item.channel}</span>
            <span className="font-semibold text-[#42536A]">{item.label}</span>
            <span>{item.atLabel}</span>
            <span className={item.status === "failed" ? "font-semibold text-red-700" : ""}>{item.status}</span>
            {item.staffName && <span>by {item.staffName}</span>}
          </p>
          {item.subject && <p className="mt-0.5 font-semibold text-[#25313F]">{item.subject}</p>}
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[#25313F]">{item.preview}</p>
        </li>
      ))}
    </ol>
  );
}
