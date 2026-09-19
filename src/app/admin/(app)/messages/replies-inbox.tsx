"use client";

import { Fragment, useMemo, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { smsSegments } from "@/lib/marketing/message";
import { REPLY_SMS_LIMIT } from "@/lib/reply-message";
// Shared class strings for the redesigned admin screens. They live under
// marketing because that is where the redesign started, not because they
// belong to it.
import { card, heading, primaryButton, secondaryButton, subtle, textarea } from "../marketing/ui";
import { markAllRepliesReadAction, markThreadReadAction, markThreadUnreadAction, sendReplyAction } from "./actions";

export type ThreadMessageView = {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  label: string;
  subject: string | null;
  body: string;
  status: string;
  timeLabel: string;
  dayLabel: string;
  staffName: string | null;
  unread: boolean;
};

export type ThreadView = {
  key: string;
  name: string;
  phoneLabel: string | null;
  address: string | null;
  customerId: string | null;
  leadId: string | null;
  unread: number;
  needsAttention: boolean;
  optedOut: boolean;
  lastAtLabel: string;
  lastPreview: string;
  lastFromThem: boolean;
  canReply: boolean;
  messages: ThreadMessageView[];
};

type Filter = "unread" | "attention" | "all";

/**
 * The inbox: conversations on the left, the selected one on the right.
 *
 * Nothing is selected on arrival, deliberately. Opening a conversation marks
 * it read, which is the behaviour everybody expects from an inbox — and would
 * be exactly the wrong thing to do to whichever thread happened to sort first.
 */
export function RepliesInbox({ threads, smsReady }: { threads: ThreadView[]; smsReady: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("unread");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const unreadTotal = threads.reduce((total, thread) => total + thread.unread, 0);
  const attentionTotal = threads.filter((thread) => thread.needsAttention).length;

  const filters: { key: Filter; label: string; count: number | null }[] = [
    { key: "unread", label: "Unread", count: unreadTotal },
    { key: "attention", label: "Wants out", count: attentionTotal },
    { key: "all", label: "All conversations", count: null },
  ];

  const visible = useMemo(() => {
    if (filter === "unread") return threads.filter((thread) => thread.unread > 0);
    if (filter === "attention") return threads.filter((thread) => thread.needsAttention);
    return threads;
  }, [threads, filter]);

  const selected = threads.find((thread) => thread.key === selectedKey) ?? null;

  function open(thread: ThreadView) {
    setSelectedKey(thread.key);
    setDraft("");
    setError(null);
    setNotice(null);
    if (thread.unread === 0 || !thread.address) return;
    const address = thread.address;
    startTransition(async () => {
      await markThreadReadAction({ address });
      router.refresh();
    });
  }

  function markUnread(thread: ThreadView) {
    if (!thread.address) return;
    const address = thread.address;
    startTransition(async () => {
      const result = await markThreadUnreadAction({ address });
      if (!result.ok) setError(result.error);
      else setNotice("Put back in the unread list.");
      router.refresh();
    });
  }

  function markAllRead() {
    startTransition(async () => {
      const result = await markAllRepliesReadAction();
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  function send(thread: ThreadView) {
    if (!thread.address) return;
    const address = thread.address;
    const body = draft.trim();
    if (body.length === 0) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await sendReplyAction({ address, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft("");
      setNotice("Sent.");
      router.refresh();
    });
  }

  if (threads.length === 0) {
    return (
      <div className={`${card} text-center`}>
        <p className={heading}>Nothing has come back yet</p>
        <p className={`mt-1 ${subtle}`}>
          Replies to your texts land here automatically. If you know customers have answered and
          nothing is showing, the Twilio number still needs its webhook pointed at this site —
          Settings → Integrations has the address to paste.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {filters.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              aria-pressed={filter === tab.key}
              className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3.5 text-xs font-semibold transition ${
                filter === tab.key
                  ? "border-[#0B2A4A] bg-[#0B2A4A] text-white admin-on-dark"
                  : "border-[#D9E1EA] bg-white text-[#42536A] hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
              }`}
            >
              {tab.label}
              {tab.count !== null && tab.count > 0 && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    filter === tab.key ? "bg-white/20 text-white" : "bg-[#FFE8E4] text-[#8A3340]"
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {unreadTotal > 0 && (
          <button type="button" onClick={markAllRead} disabled={pending} className={secondaryButton}>
            Mark all read
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={`${selected ? "hidden lg:block" : ""}`}>
          {visible.length === 0 ? (
            <p className={`${card} text-center ${subtle}`}>
              {filter === "unread" ? "Everything has been read." : "Nothing matches that filter."}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((thread) => (
                <li key={thread.key}>
                  <button
                    type="button"
                    onClick={() => open(thread)}
                    aria-current={thread.key === selectedKey ? "true" : undefined}
                    className={`w-full rounded-2xl border p-3.5 text-left transition ${
                      thread.key === selectedKey
                        ? "border-[#0B2A4A] bg-white shadow-[0_8px_24px_rgba(11,42,74,0.08)]"
                        : "border-[#DCE4EC] bg-white hover:border-[#0B2A4A]/30"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        {thread.unread > 0 && (
                          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[#C2453C]" />
                        )}
                        <span
                          className={`truncate text-sm ${thread.unread > 0 ? "font-bold text-[#0B2A4A]" : "font-semibold text-[#42536A]"}`}
                        >
                          {thread.name}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] font-semibold text-[#8A97A6]">{thread.lastAtLabel}</span>
                    </span>
                    <span className={`mt-1 block truncate ${subtle}`}>
                      {thread.lastFromThem ? "" : "You: "}
                      {thread.lastPreview}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {thread.unread > 0 && (
                        <Chip tone="bg-[#FFE8E4] text-[#8A3340]">
                          {thread.unread} unread
                        </Chip>
                      )}
                      {thread.needsAttention && <Chip tone="bg-[#FFF3D6] text-[#8A681F]">Wants out</Chip>}
                      {thread.optedOut && <Chip tone="bg-[#EEF2F6] text-[#4C5F73]">Opted out</Chip>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <Conversation
            thread={selected}
            smsReady={smsReady}
            draft={draft}
            onDraft={setDraft}
            onSend={() => send(selected)}
            onBack={() => setSelectedKey(null)}
            onMarkUnread={() => markUnread(selected)}
            pending={pending}
            error={error}
            notice={notice}
          />
        ) : (
          <div className={`${card} hidden place-content-center text-center lg:grid`}>
            <p className={heading}>Pick a conversation</p>
            <p className={`mt-1 ${subtle}`}>Opening one marks it read and shows the whole thread.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  thread,
  smsReady,
  draft,
  onDraft,
  onSend,
  onBack,
  onMarkUnread,
  pending,
  error,
  notice,
}: {
  thread: ThreadView;
  smsReady: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onBack: () => void;
  onMarkUnread: () => void;
  pending: boolean;
  error: string | null;
  notice: string | null;
}) {
  const segments = smsSegments(draft);
  const blocked = replyBlockReason(thread, smsReady);

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E3E8EF] pb-4">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="mb-1 text-xs font-semibold text-[#8A681F] lg:hidden">
            ← All conversations
          </button>
          <p className={`${heading} truncate`}>{thread.name}</p>
          <p className={`mt-0.5 ${subtle}`}>
            {thread.phoneLabel ?? "No number on file"}
            {thread.customerId && (
              <>
                {" · "}
                <Link href={`/admin/customers/${thread.customerId}`} className="font-semibold text-[#8A681F] hover:underline">
                  Customer record
                </Link>
              </>
            )}
            {thread.leadId && (
              <>
                {" · "}
                <Link href={`/admin/leads/${thread.leadId}`} className="font-semibold text-[#8A681F] hover:underline">
                  Lead
                </Link>
              </>
            )}
          </p>
        </div>
        {thread.canReply && (
          <button type="button" onClick={onMarkUnread} disabled={pending} className={secondaryButton}>
            Mark unread
          </button>
        )}
      </div>

      <ol className="mt-4 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
        {thread.messages.map((message, index) => (
          <Fragment key={message.id}>
            {message.dayLabel !== thread.messages[index - 1]?.dayLabel && (
              <li className="pt-1 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-[#8A97A6]">
                {message.dayLabel}
              </li>
            )}
            <li className={message.direction === "inbound" ? "flex justify-start" : "flex justify-end"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                  message.direction === "inbound"
                    ? "border border-[#DCE4EC] bg-[#F4F6FA]"
                    : "border border-[#C9D8E6] bg-[#EAF2FA]"
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#77869A]">
                  {message.label}
                  {message.channel === "email" && " · email"}
                  {message.staffName && ` · ${message.staffName}`}
                  {message.status === "failed" && " · not delivered"}
                </p>
                {message.subject && (
                  <p className="mt-1 text-sm font-semibold text-[#0B2A4A]">{message.subject}</p>
                )}
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#1C2026]">
                  {message.body}
                </p>
                <p className="mt-1 text-[10px] font-semibold text-[#8A97A6]">{message.timeLabel}</p>
              </div>
            </li>
          </Fragment>
        ))}
      </ol>

      <div className="mt-4 border-t border-[#E3E8EF] pt-4">
        {blocked ? (
          <p className={`rounded-xl bg-[#F4F6FA] p-3 ${subtle}`}>{blocked}</p>
        ) : (
          <>
            <label className="block text-xs font-semibold text-[#526A80]" htmlFor="reply-body">
              Reply by text
            </label>
            <textarea
              id="reply-body"
              rows={3}
              value={draft}
              maxLength={REPLY_SMS_LIMIT}
              onChange={(event) => onDraft(event.target.value)}
              placeholder={`Answer ${thread.name.split(" ")[0]}…`}
              className={textarea}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className={subtle}>
                {segments.characters}/{REPLY_SMS_LIMIT} characters ·{" "}
                {segments.segments} {segments.segments === 1 ? "segment" : "segments"}
                {segments.encoding === "UCS-2" && " · special characters halve what fits"}
              </p>
              <button
                type="button"
                onClick={onSend}
                disabled={pending || draft.trim().length === 0}
                className={primaryButton}
              >
                {pending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </>
        )}
        {error && <p className="mt-2 text-xs font-semibold text-[#8A3340]">{error}</p>}
        {notice && !error && <p className="mt-2 text-xs font-semibold text-[#2F6B4F]">{notice}</p>}
      </div>
    </div>
  );
}

/** Why this conversation cannot be answered from here, or null if it can. */
function replyBlockReason(thread: ThreadView, smsReady: boolean): string | null {
  if (thread.optedOut) {
    return "They replied STOP, so the carrier blocks texts to this number. Call them if you need to reach them.";
  }
  if (!thread.canReply) {
    return "This reply arrived before the number was recorded, so there is nothing to send back to. Open their record to find a number.";
  }
  if (!smsReady) {
    return "Texting is not configured yet — add the Twilio credentials in Settings → Integrations.";
  }
  return null;
}

function Chip({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}>{children}</span>
  );
}
