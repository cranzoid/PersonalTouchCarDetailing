"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { smsSegments } from "@/lib/marketing/message";
import {
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_METHODS,
  FOLLOW_UP_PLACEHOLDERS,
  LOGGED_FOLLOW_UP_METHODS,
  followUpWordingProblem,
  renderFollowUp,
  type FollowUpChannel,
  type FollowUpValues,
} from "@/lib/quote-follow-up-message";
import {
  addQuoteCommentAction,
  logQuoteFollowUpAction,
  saveFollowUpWordingAction,
  sendQuoteFollowUpAction,
  setQuoteNextFollowUpAction,
} from "./actions";

type Tab = "sms" | "email" | "log" | "comment";
type LoggedMethod = (typeof LOGGED_FOLLOW_UP_METHODS)[number];

const TABS: { key: Tab; label: string }[] = [
  { key: "sms", label: "Text" },
  { key: "email", label: "Email" },
  { key: "log", label: "Log a call" },
  { key: "comment", label: "Comment" },
];

const fieldClass = "rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
const inputClass = `w-full ${fieldClass}`;
const primaryButton =
  "rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40";
const secondaryButton =
  "rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500 disabled:opacity-40";

export function FollowUpPanel({
  quoteRequestId,
  contact,
  blocked,
  smsWindow,
  values,
  businessName,
  wording,
  canSaveDefault,
  schedule,
}: {
  quoteRequestId: string;
  contact: { phone: string | null; email: string | null };
  /** Why each channel cannot be used for this request, or null if it can. */
  blocked: { sms: string | null; email: string | null };
  smsWindow: { allowed: boolean; localHour: number };
  values: FollowUpValues;
  businessName: string;
  wording: { sms: string; emailSubject: string; emailBody: string };
  canSaveDefault: boolean;
  schedule: {
    /** The scheduled day, "YYYY-MM-DD", or null. */
    next: string | null;
    /** What the date field suggests after a follow-up. */
    suggested: string;
  };
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(blocked.sms && !blocked.email ? "email" : "sms");
  const [smsBody, setSmsBody] = useState(wording.sms);
  const [emailSubject, setEmailSubject] = useState(wording.emailSubject);
  const [emailBody, setEmailBody] = useState(wording.emailBody);
  const [focusField, setFocusField] = useState<"subject" | "body">("body");
  const [method, setMethod] = useState<LoggedMethod>("call");
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [nextAfter, setNextAfter] = useState(schedule.suggested);
  const [busy, setBusy] = useState<null | "send" | "save" | "log" | "comment">(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const channel: FollowUpChannel | null = tab === "sms" || tab === "email" ? tab : null;
  const body = channel === "email" ? emailBody : smsBody;
  const setBody = channel === "email" ? setEmailBody : setSmsBody;
  const subject = channel === "email" ? emailSubject : "";

  const renderedSubject = renderFollowUp(subject, values);
  const renderedBody = renderFollowUp(body, values);
  const problem = channel
    ? followUpWordingProblem({ channel, subject, body, values, businessName })
    : null;
  const warnings = channel
    ? checkCampaignCompliance({
        channel,
        subject: channel === "email" ? renderedSubject : null,
        body: renderedBody,
        businessName,
      })
        .filter((issue) => issue.level === "warning")
        .map((issue) => issue.message)
    : [];
  const segments = channel === "sms" ? smsSegments(renderedBody) : null;

  const sendBlocker = !channel
    ? null
    : blocked[channel] ??
      (channel === "sms" && !smsWindow.allowed
        ? `It is ${smsWindow.localHour}:00 — follow-up texts only go out between 9am and 8pm.`
        : problem
          ? "Fix the message first."
          : null);

  function switchTab(next: Tab) {
    setTab(next);
    setFocusField("body");
    setNotice(null);
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
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function resetWording() {
    if (channel === "email") {
      setEmailSubject(wording.emailSubject);
      setEmailBody(wording.emailBody);
    } else {
      setSmsBody(wording.sms);
    }
  }

  async function run(
    kind: NonNullable<typeof busy>,
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    success: string,
    after?: () => void,
  ) {
    setBusy(kind);
    setNotice(null);
    const result = await action();
    setBusy(null);
    if (!result.ok) {
      setNotice({ ok: false, text: result.error });
      return;
    }
    setNotice({ ok: true, text: success });
    after?.();
    router.refresh();
  }

  const nextAfterField = (
    <label className="block text-xs text-ink-400">
      Follow up again on
      <span className="mt-1 flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={nextAfter}
          onChange={(event) => setNextAfter(event.target.value)}
          className={fieldClass}
        />
        {nextAfter ? (
          <button type="button" onClick={() => setNextAfter("")} className="text-xs text-ink-400 hover:text-accent-300">
            No more follow-ups
          </button>
        ) : (
          <span className="text-xs text-ink-500">None — it will drop off the due list.</span>
        )}
      </span>
    </label>
  );

  return (
    <section className="mt-6 rounded-xl border border-ink-800 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Follow up</h2>
        {/* Keyed on the saved date so a send or log that moves it resets the field. */}
        <NextFollowUpForm key={schedule.next ?? "none"} quoteRequestId={quoteRequestId} saved={schedule.next} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Follow-up type">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => switchTab(t.key)}
            className={`rounded-full px-4 py-1.5 text-sm ${
              tab === t.key ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {channel && (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-ink-300">
            To{" "}
            <strong className="text-white">
              {(channel === "sms" ? contact.phone : contact.email) ?? (channel === "sms" ? "no phone number" : "no email address")}
            </strong>
          </p>
          {blocked[channel] && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-300">
              {blocked[channel]}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {FOLLOW_UP_PLACEHOLDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.hint}
                onClick={() => insertPlaceholder(p.key)}
                className="rounded-md bg-ink-800 px-2 py-1 font-mono text-[11px] text-ink-300 hover:text-accent-300"
              >
                {`{{${p.key}}}`}
              </button>
            ))}
          </div>

          {channel === "email" && (
            <label className="block text-xs text-ink-400">
              Subject
              <input
                ref={subjectRef}
                value={emailSubject}
                maxLength={FOLLOW_UP_LIMITS.emailSubject}
                onFocus={() => setFocusField("subject")}
                onChange={(event) => setEmailSubject(event.target.value)}
                className={`${inputClass} mt-1`}
              />
            </label>
          )}
          <label className="block text-xs text-ink-400">
            Message
            <textarea
              ref={bodyRef}
              rows={channel === "email" ? 10 : 4}
              value={body}
              maxLength={channel === "email" ? FOLLOW_UP_LIMITS.emailBody : FOLLOW_UP_LIMITS.smsBody}
              onFocus={() => setFocusField("body")}
              onChange={(event) => setBody(event.target.value)}
              className={`${inputClass} mt-1`}
            />
          </label>

          <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">What they will see</p>
            {channel === "email" && <p className="mt-2 text-sm font-semibold text-white">{renderedSubject}</p>}
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-200">{renderedBody}</p>
            {channel === "email" && (
              <p className="mt-3 text-xs text-ink-500">
                The shop&apos;s address, phone and an unsubscribe link are added below this automatically.
              </p>
            )}
            {segments && (
              <p className="mt-2 text-xs text-ink-500">
                {segments.characters} characters · {segments.segments} text{segments.segments === 1 ? "" : "s"} to send
                {segments.encoding === "UCS-2" &&
                  ` · ${segments.nonGsmCharacters.join(" ")} make${segments.nonGsmCharacters.length === 1 ? "s" : ""} it cost more — swap for plain characters`}
              </p>
            )}
          </div>

          {problem && <p className="text-sm text-red-300">{problem}</p>}
          {warnings.map((warning) => (
            <p key={warning} className="text-sm text-amber-300">{warning}</p>
          ))}

          {nextAfterField}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy !== null || sendBlocker !== null}
              onClick={() =>
                void run(
                  "send",
                  () =>
                    sendQuoteFollowUpAction({
                      quoteRequestId,
                      channel,
                      subject,
                      body,
                      nextFollowUpOn: nextAfter || null,
                    }),
                  channel === "sms" ? "Text sent and recorded as a follow-up." : "Email sent and recorded as a follow-up.",
                )
              }
              className={primaryButton}
            >
              {busy === "send" ? "Sending…" : channel === "sms" ? "Send text" : "Send email"}
            </button>
            <button type="button" onClick={resetWording} disabled={busy !== null} className={secondaryButton}>
              Reset wording
            </button>
            {canSaveDefault && (
              <button
                type="button"
                disabled={busy !== null || problem !== null}
                onClick={() =>
                  void run(
                    "save",
                    () => saveFollowUpWordingAction({ channel, subject, body }),
                    `Saved. Every request's ${channel === "sms" ? "text" : "email"} will start from this wording.`,
                  )
                }
                className={secondaryButton}
              >
                {busy === "save" ? "Saving…" : "Save as default wording"}
              </button>
            )}
            {sendBlocker && !blocked[channel] && <span className="text-xs text-ink-500">{sendBlocker}</span>}
          </div>
        </div>
      )}

      {tab === "log" && (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "log",
              () => logQuoteFollowUpAction({ quoteRequestId, method, note, nextFollowUpOn: nextAfter || null }),
              "Follow-up recorded.",
              () => setNote(""),
            );
          }}
        >
          <p className="text-sm text-ink-400">For a follow-up that happened outside the CRM — a call, a voicemail, a chat at the counter.</p>
          <label className="block text-xs text-ink-400">
            How
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as LoggedMethod)}
              className={`${inputClass} mt-1 sm:w-64`}
            >
              {LOGGED_FOLLOW_UP_METHODS.map((m) => (
                <option key={m} value={m}>{FOLLOW_UP_METHODS[m]}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-400">
            What happened (optional)
            <textarea
              rows={3}
              value={note}
              maxLength={FOLLOW_UP_LIMITS.note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Wants it done before winter, will call back Friday with a date."
              className={`${inputClass} mt-1`}
            />
          </label>
          {nextAfterField}
          <button type="submit" disabled={busy !== null} className={primaryButton}>
            {busy === "log" ? "Saving…" : "Record follow-up"}
          </button>
        </form>
      )}

      {tab === "comment" && (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "comment",
              () => addQuoteCommentAction({ quoteRequestId, body: comment }),
              "Comment added.",
              () => setComment(""),
            );
          }}
        >
          <label className="block text-xs text-ink-400">
            Comment for the team — the customer never sees this
            <textarea
              rows={3}
              value={comment}
              maxLength={FOLLOW_UP_LIMITS.note}
              onChange={(event) => setComment(event.target.value)}
              className={`${inputClass} mt-1`}
            />
          </label>
          <button type="submit" disabled={busy !== null || comment.trim().length === 0} className={primaryButton}>
            {busy === "comment" ? "Saving…" : "Add comment"}
          </button>
        </form>
      )}

      {notice && (
        <p className={`mt-4 text-sm ${notice.ok ? "text-emerald-300" : "text-red-300"}`}>{notice.text}</p>
      )}
    </section>
  );
}

/** Moves or clears the scheduled day, without recording a follow-up. */
function NextFollowUpForm({ quoteRequestId, saved }: { quoteRequestId: string; saved: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs text-ink-400"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await setQuoteNextFollowUpAction({ quoteRequestId, nextFollowUpOn: value || null });
        setBusy(false);
        if (!result.ok) setError(result.error);
        else router.refresh();
      }}
    >
      <label htmlFor="next-follow-up">Next follow-up</label>
      <input
        id="next-follow-up"
        type="date"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="rounded-lg border border-ink-600 bg-ink-950 px-3 py-1 text-sm text-white"
      />
      <button type="submit" disabled={busy || value === (saved ?? "")} className={`${secondaryButton} px-3 py-1 text-xs`}>
        {busy ? "Saving…" : value ? "Save date" : "Clear date"}
      </button>
      {error && <span className="w-full text-red-300">{error}</span>}
    </form>
  );
}
