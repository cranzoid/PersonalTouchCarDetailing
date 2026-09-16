"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { smsSegments } from "@/lib/marketing/message";
import { matchesSearch } from "@/lib/option-search";
import {
  MAX_NUDGE_BATCH,
  NUDGE_LIMITS,
  NUDGE_PLACEHOLDERS,
  renderNudge,
  unknownNudgePlaceholders,
  type NudgeChannel,
  type NudgeValues,
} from "@/lib/wash-offer-nudge-message";
import { card, heading, input, label, primaryButton, secondaryButton, subtle, textarea } from "../ui";
import { saveNudgeWordingAction, sendNudgeTestAction, sendWashNudgesAction } from "./actions";

export type NudgeHistoryItem = {
  id: string;
  atLabel: string;
  channel: string;
  label: string;
  status: string;
  subject: string | null;
  preview: string;
  staffName: string | null;
};

export type NudgeRow = {
  id: string;
  leadId: string | null;
  appointmentId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  code: string;
  state: "open" | "booked" | "washed" | "expired" | "released";
  claimedLabel: string;
  expiresLabel: string;
  daysLeft: string | null;
  appointmentLabel: string | null;
  smsNudges: number;
  emailNudges: number;
  lastNudgeLabel: string | null;
  /** Why this person cannot be texted / emailed right now, or null. */
  blockedSms: string | null;
  blockedEmail: string | null;
  /** Their own values for the preview; null when the offer is off. */
  values: NudgeValues | null;
  history: NudgeHistoryItem[];
};

type Outcome = { claimId: string; name: string; status: "sent" | "skipped" | "failed"; reason?: string };

type Filter = "open" | "never" | "booked" | "washed" | "expired" | "all";

const FILTERS: { key: Filter; label: string; test: (row: NudgeRow) => boolean }[] = [
  { key: "open", label: "Not booked yet", test: (r) => r.state === "open" },
  { key: "never", label: "Never nudged", test: (r) => r.state === "open" && r.smsNudges + r.emailNudges === 0 },
  { key: "booked", label: "Booked", test: (r) => r.state === "booked" },
  { key: "washed", label: "Washed", test: (r) => r.state === "washed" },
  { key: "expired", label: "Expired / released", test: (r) => r.state === "expired" || r.state === "released" },
  { key: "all", label: "Everyone", test: () => true },
];

const STATE_BADGES: Record<NudgeRow["state"], { label: string; tone: string }> = {
  open: { label: "Code not used", tone: "bg-[#FFF3D6] text-[#8A681F]" },
  booked: { label: "Booked", tone: "bg-[#E7F2EA] text-emerald-800" },
  washed: { label: "Washed", tone: "bg-[#0B2A4A] text-white admin-on-dark" },
  expired: { label: "Expired", tone: "bg-[#EEF2F7] text-[#42536A]" },
  released: { label: "Released", tone: "bg-[#F6E9E9] text-red-800" },
};

const OUTCOME_TONES: Record<Outcome["status"], string> = {
  sent: "text-emerald-700",
  skipped: "text-[#8A681F]",
  failed: "text-red-700",
};

export function NudgeWorkspace({
  rows,
  stats,
  offerActive,
  businessName,
  sendWindow,
  providerReady,
  sample,
  templates,
}: {
  rows: NudgeRow[];
  stats: { open: number; neverNudged: number; textsSent: number; emailsSent: number; booked: number; washed: number };
  offerActive: boolean;
  businessName: string;
  sendWindow: { allowed: boolean; localHour: number };
  providerReady: { sms: boolean; email: boolean };
  sample: NudgeValues | null;
  templates: { sms: string; emailSubject: string; emailBody: string };
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<NudgeChannel>("sms");
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [smsBody, setSmsBody] = useState(templates.sms);
  const [emailSubject, setEmailSubject] = useState(templates.emailSubject);
  const [emailBody, setEmailBody] = useState(templates.emailBody);
  const [focusField, setFocusField] = useState<"subject" | "body">("body");
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
  const blockedFor = (row: NudgeRow) => (channel === "sms" ? row.blockedSms : row.blockedEmail);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(f.test).length])) as Record<Filter, number>,
    [rows],
  );
  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    return rows.filter(
      (row) =>
        test(row) &&
        (!query.trim() || matchesSearch([row.name, row.phone, row.email, row.code].filter(Boolean).join(" "), query)),
    );
  }, [rows, filter, query]);

  const selectedRows = rows.filter((row) => selected.has(row.id));
  const sendable = selectedRows.filter((row) => !blockedFor(row));
  const heldBack = selectedRows.length - sendable.length;

  const previewValues = sendable[0]?.values ?? sample;
  const renderedSubject = previewValues ? renderNudge(subject, previewValues) : subject;
  const renderedBody = previewValues ? renderNudge(body, previewValues) : body;
  const unknown = unknownNudgePlaceholders(subject, body);
  const issues = checkCampaignCompliance({
    channel,
    subject: channel === "email" ? renderedSubject : null,
    body: renderedBody,
    businessName,
  });
  const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
  if (unknown.length > 0) {
    errors.unshift(`Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}`);
  }
  if (channel === "sms" && body.length > NUDGE_LIMITS.smsBody) {
    errors.push(`Texts are limited to ${NUDGE_LIMITS.smsBody} characters.`);
  }
  const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);
  const segments = channel === "sms" ? smsSegments(renderedBody) : null;

  const sendBlocker = !offerActive
    ? "The wash offer is switched off."
    : !providerReady[channel]
      ? channel === "sms"
        ? "Twilio is not configured (Settings → Integrations)."
        : "Email sending is not configured (Settings → Integrations)."
      : !sendWindow.allowed
        ? `It is ${sendWindow.localHour}:00 — nudges only go out between 9am and 8pm.`
        : errors.length > 0
          ? "Fix the message first."
          : sendable.length === 0
            ? "Tick the people to nudge."
            : null;

  function switchChannel(next: NudgeChannel) {
    setChannel(next);
    setConfirming(false);
    setFocusField("body");
  }

  function toggle(id: string) {
    setConfirming(false);
    if (!selected.has(id) && selected.size >= MAX_NUDGE_BATCH) {
      setNotice({ ok: false, text: `Up to ${MAX_NUDGE_BATCH} people at a time — send these, then pick the next ones.` });
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
    setSelected(new Set(visible.filter((row) => !blockedFor(row)).slice(0, MAX_NUDGE_BATCH).map((row) => row.id)));
  }

  function toggleHistory(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Drops `{{key}}` in at the cursor of whichever field was last focused. */
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
    const result = await sendWashNudgesAction({
      claimIds: sendable.map((row) => row.id),
      channel,
      subject,
      body,
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
      for (const outcome of result.outcomes) if (outcome.status === "sent") next.delete(outcome.claimId);
      return next;
    });
    router.refresh();
  }

  async function save() {
    setBusy("save");
    setNotice(null);
    const result = await saveNudgeWordingAction({ channel, subject, body });
    setBusy(null);
    setNotice(
      result.ok
        ? { ok: true, text: `Saved. The ${channel === "sms" ? "text" : "email"} will open with this wording next time.` }
        : { ok: false, text: result.error },
    );
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    const result = await sendNudgeTestAction({ channel, subject, body, destination: testTo });
    setBusy(null);
    setNotice(
      result.ok
        ? { ok: true, text: `Test sent to ${testTo}, filled in with sample details.` }
        : { ok: false, text: result.error },
    );
  }

  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {(
          [
            ["Codes not used yet", stats.open],
            ["Never nudged", stats.neverNudged],
            ["Nudge texts sent", stats.textsSent],
            ["Nudge emails sent", stats.emailsSent],
            ["Booked", stats.booked],
            ["Washed", stats.washed],
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
                Select {channel === "sms" ? "textable" : "emailable"} in view (max {MAX_NUDGE_BATCH})
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

          <label className="mt-3 block">
            <span className="sr-only">Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, phone, email or code"
              className={input}
            />
          </label>

          {visible.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#F6F8FA] px-4 py-10 text-center text-sm text-[#5A6B7D]">
              Nobody here{query.trim() ? " matches that search" : ""}.
            </p>
          ) : (
            // `relative` so the screen-reader-only header text is clipped by
            // this scroller instead of widening the whole page on a phone.
            <div className="relative mt-4 overflow-x-auto">
              <table className="w-full min-w-[28rem] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-9" />
                  <col />
                  <col className="w-[34%]" />
                  <col className="w-[27%]" />
                </colgroup>
                <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                  <tr>
                    <th className="py-2 pr-2 font-semibold">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="py-2 pr-3 font-semibold">Customer</th>
                    <th className="py-2 pr-3 font-semibold">Code</th>
                    <th className="py-2 font-semibold">Nudges sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EBF0F5]">
                  {visible.map((row) => {
                    const blocked = blockedFor(row);
                    const isSelected = selected.has(row.id);
                    const isOpen = expanded.has(row.id);
                    const badge = STATE_BADGES[row.state];
                    return (
                      <Fragment key={row.id}>
                        <tr className={`align-top ${isSelected ? "bg-[#FBF6EC]" : ""}`}>
                          <td className="py-3 pr-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 disabled:opacity-30"
                              checked={isSelected}
                              disabled={Boolean(blocked) && !isSelected}
                              onChange={() => toggle(row.id)}
                              aria-label={`Select ${row.name}`}
                            />
                          </td>
                          <td className="break-words py-3 pr-3">
                            {row.leadId ? (
                              <Link href={`/admin/leads/${row.leadId}`} className="font-semibold text-[#0B2A4A] hover:underline">
                                {row.name}
                              </Link>
                            ) : (
                              <span className="font-semibold text-[#0B2A4A]">{row.name}</span>
                            )}
                            {row.phone && <span className="mt-0.5 block text-xs text-[#5A6B7D]">{row.phone}</span>}
                            {row.email && <span className="block break-all text-xs text-[#5A6B7D]">{row.email}</span>}
                            {blocked && (
                              <span
                                className={`mt-1 block text-[11px] font-semibold ${
                                  isSelected ? "text-red-700" : "text-[#8592A0]"
                                }`}
                              >
                                {isSelected ? `Will be skipped — ${blocked.toLowerCase()}` : blocked}
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <span className="block font-mono text-xs font-bold text-[#0B2A4A]">{row.code}</span>
                            <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.tone}`}>
                              {badge.label}
                            </span>
                            <span className="mt-1 block text-[11px] text-[#5A6B7D]">
                              Claimed {row.claimedLabel}
                              {row.state === "open" && row.daysLeft && ` · ${row.daysLeft} left (${row.expiresLabel})`}
                              {row.state === "expired" && ` · expired ${row.expiresLabel}`}
                            </span>
                            {row.appointmentLabel && row.appointmentId && (
                              <Link
                                href={`/admin/appointments/${row.appointmentId}`}
                                className="mt-0.5 block text-[11px] font-semibold text-[#8A681F] hover:underline"
                              >
                                {row.appointmentLabel}
                              </Link>
                            )}
                          </td>
                          <td className="py-3 text-xs text-[#42536A]">
                            <span className="block">
                              <strong className="text-[#0B2A4A]">{row.smsNudges}</strong> text{row.smsNudges === 1 ? "" : "s"} ·{" "}
                              <strong className="text-[#0B2A4A]">{row.emailNudges}</strong> email{row.emailNudges === 1 ? "" : "s"}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-[#8592A0]">
                              {row.lastNudgeLabel ? `Last nudged ${row.lastNudgeLabel}` : "Not nudged yet"}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleHistory(row.id)}
                              aria-expanded={isOpen}
                              className="-ml-2 mt-1 rounded-lg px-2 py-1 text-xs font-semibold text-[#8A681F] hover:bg-[#FBF6EC]"
                            >
                              {isOpen ? "Hide messages" : `Messages (${row.history.length})`}
                            </button>
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
                  maxLength={NUDGE_LIMITS.emailSubject}
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
                {NUDGE_PLACEHOLDERS.map((placeholder) => (
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
                {segments.characters} characters · {segments.segments} SMS segment{segments.segments === 1 ? "" : "s"} per
                person ({segments.encoding})
                {segments.nonGsmCharacters.length > 0 && (
                  <span className="block text-[#8A681F]">
                    {segments.nonGsmCharacters.map((c) => `“${c}”`).join(" ")} make{segments.nonGsmCharacters.length === 1 ? "s" : ""} every
                    segment shorter — swap for plain characters to save money.
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
                  <li key={message} className="rounded-lg border border-[#E7C0C0] bg-[#FDF4F4] px-3 py-2 text-xs text-[#8B3F3F]">
                    {message}
                  </li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {warnings.map((message) => (
                  <li key={message} className="rounded-lg border border-[#E7C878] bg-[#FFF9E9] px-3 py-2 text-xs text-[#7A5F1E]">
                    {message}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8494A5]">
                Preview — {sendable[0] ? sendable[0].name : "sample customer"}
              </p>
              {channel === "email" && (
                <p className="mt-1.5 text-sm font-semibold text-[#0B2A4A]">{renderedSubject}</p>
              )}
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

            <div className="mt-5 border-t border-[#E4EAF0] pt-4">
              <p className="text-sm font-semibold text-[#0B2A4A]">
                {sendable.length} {sendable.length === 1 ? "person" : "people"} selected
              </p>
              {heldBack > 0 && (
                <p className="mt-0.5 text-xs text-[#8A681F]">
                  {heldBack} more ticked but cannot get {channel === "sms" ? "a text" : "an email"} right now — they will be left out.
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
                  Send {channel === "sms" ? "text" : "email"} to {sendable.length} {sendable.length === 1 ? "person" : "people"}
                </button>
              ) : (
                <div className="mt-3 rounded-xl border border-[#E0A93B]/60 bg-[#FBF6EC] p-3">
                  <p className="text-sm text-[#42536A]">
                    Send this {channel === "sms" ? "text" : "email"} to {sendable.map((row) => row.name).join(", ")} now?
                  </p>
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
                  <li key={outcome.claimId} className="flex flex-wrap justify-between gap-2">
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
                disabled={busy !== null || testTo.trim().length < 3 || errors.length > 0 || !offerActive}
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

function History({ items }: { items: NudgeHistoryItem[] }) {
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
