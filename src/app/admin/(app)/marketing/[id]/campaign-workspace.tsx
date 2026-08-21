"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComplianceIssue } from "@/lib/marketing/compliance";
import { MAX_BATCH_SIZE, renderOutreachBody, smsSegments, unknownMergeFields } from "@/lib/marketing/message";
import {
  importContactsAction,
  removeRecipientsAction,
  sendBatchAction,
  sendTestAction,
  setCampaignStatusAction,
  updateCampaignAction,
} from "../actions";
import { card, heading, input, label, primaryButton, secondaryButton, subtle, textarea } from "../ui";

type Recipient = {
  id: string;
  leadId: string | null;
  customerId: string | null;
  destination: string;
  firstName: string;
  companyName: string;
  status: string;
  skipReason: string | null;
  sentAt: string | null;
  replies: { id: string; body: string; kind: string }[];
};

type Campaign = {
  id: string;
  name: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  status: string;
  allowRecontact: boolean;
};

type BatchResult = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  results: { recipientId: string; destination: string; status: string; reason?: string }[];
};

const CONSENT_BASES = [
  { value: "business_card", label: "They gave me their card or details in person" },
  { value: "verbal", label: "They said yes when I asked in person" },
  { value: "existing_customer", label: "Existing customer of the shop" },
] as const;

const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting",
  claimed: "In flight",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-[#EEF2F6] text-[#4C5F73]",
  claimed: "bg-[#FFF3D6] text-[#8A681F]",
  sent: "bg-[#E4F4EA] text-[#2C6B45]",
  failed: "bg-[#F6E8E8] text-[#8B3F3F]",
  skipped: "bg-[#F1EDF6] text-[#5C4A78]",
};

export function CampaignWorkspace({
  campaign,
  recipients,
  issues,
  sendWindow,
  businessName,
}: {
  campaign: Campaign;
  recipients: Recipient[];
  issues: ComplianceIssue[];
  sendWindow: { allowed: boolean; localHour: number };
  businessName: string;
}) {
  const router = useRouter();
  const [batch, setBatch] = useState<BatchResult | null>(null);

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const r of recipients) tally[r.status] = (tally[r.status] ?? 0) + 1;
    return tally;
  }, [recipients]);

  const pending = counts.pending ?? 0;
  const sent = counts.sent ?? 0;
  const locked = sent > 0;
  const errors = issues.filter((i) => i.level === "error");
  const warnings = [...issues.filter((i) => i.level === "warning")];

  // A blank merge value renders as nothing, so "work with {{Company}}" becomes
  // "work with ." — worth catching before it goes out, not after.
  const blanks = useMemo(() => {
    const gaps: string[] = [];
    if (campaign.body.includes("{{Company}}")) {
      const n = recipients.filter((r) => r.status === "pending" && !r.companyName.trim()).length;
      if (n > 0) gaps.push(`${n} waiting contact${n === 1 ? " has" : "s have"} no company name`);
    }
    if (campaign.body.includes("{{FirstName}}")) {
      const n = recipients.filter((r) => r.status === "pending" && !r.firstName.trim()).length;
      if (n > 0) gaps.push(`${n} waiting contact${n === 1 ? " has" : "s have"} no first name`);
    }
    return gaps;
  }, [campaign.body, recipients]);
  for (const gap of blanks) {
    warnings.push({
      level: "warning",
      message: `${gap} — that placeholder will come out blank in their message.`,
    });
  }

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="space-y-6">
        <SendPanel
          campaign={campaign}
          pending={pending}
          sent={sent}
          total={recipients.length}
          blocking={errors}
          warnings={warnings}
          sendWindow={sendWindow}
          batch={batch}
          onBatch={setBatch}
          onChanged={() => router.refresh()}
        />
        <Composer campaign={campaign} locked={locked} businessName={businessName} onSaved={() => router.refresh()} />
        <ImportPanel campaignId={campaign.id} channel={campaign.channel} onImported={() => router.refresh()} />
        <RecipientTable campaignId={campaign.id} recipients={recipients} onChanged={() => router.refresh()} />
      </div>

      <div className="space-y-6">
        <PreviewPanel campaign={campaign} recipients={recipients} />
        <TestPanel campaign={campaign} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SendPanel({
  campaign,
  pending,
  sent,
  total,
  blocking,
  warnings,
  sendWindow,
  batch,
  onBatch,
  onChanged,
}: {
  campaign: Campaign;
  pending: number;
  sent: number;
  total: number;
  blocking: ComplianceIssue[];
  warnings: ComplianceIssue[];
  sendWindow: { allowed: boolean; localHour: number };
  batch: BatchResult | null;
  onBatch: (result: BatchResult | null) => void;
  onChanged: () => void;
}) {
  const [size, setSize] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const closed = campaign.status === "completed" || campaign.status === "cancelled";
  const paused = campaign.status === "paused";
  const canSend =
    !busy && pending > 0 && blocking.length === 0 && sendWindow.allowed && !closed && !paused;

  async function send() {
    setBusy(true);
    setError(null);
    const result = await sendBatchAction({
      campaignId: campaign.id,
      size,
      acknowledgeWarnings: acknowledged || warnings.length === 0,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      // The server asks for confirmation once; the next press carries it.
      if (warnings.length > 0) setAcknowledged(true);
      return;
    }
    onBatch(result.outcome);
    onChanged();
  }

  async function setStatus(status: "sending" | "paused" | "cancelled") {
    setBusy(true);
    setError(null);
    const result = await setCampaignStatusAction({ campaignId: campaign.id, status });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onChanged();
  }

  return (
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={heading}>Send</h2>
          <p className={`mt-1 ${subtle}`}>
            {sent} of {total} sent · {pending} waiting
          </p>
        </div>
        {!closed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus(paused ? "sending" : "paused")}
            className={secondaryButton}
          >
            {paused ? "Resume campaign" : "Pause campaign"}
          </button>
        )}
      </div>

      {total > 0 && (
        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-[#E8EDF2]">
          <div
            className="h-full rounded-full bg-[#2C6B45]"
            style={{ width: `${Math.round((sent / total) * 100)}%` }}
          />
        </div>
      )}

      {blocking.length > 0 && (
        <ul className="mt-4 space-y-2">
          {blocking.map((issue) => (
            <li key={issue.message} className="rounded-xl border border-[#E7C0C0] bg-[#FDF4F4] px-3.5 py-2.5 text-sm text-[#8B3F3F]">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="mt-4 space-y-2">
          {warnings.map((issue) => (
            <li key={issue.message} className="rounded-xl border border-[#E7C878] bg-[#FFF9E9] px-3.5 py-2.5 text-sm text-[#7A5F1E]">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {!sendWindow.allowed && (
        <p className="mt-4 rounded-xl border border-[#E7C878] bg-[#FFF9E9] px-3.5 py-2.5 text-sm text-[#7A5F1E]">
          It is {sendWindow.localHour}:00 locally. Marketing messages only go out between 9am and 8pm.
        </p>
      )}

      {!closed && (
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className={label}>
            Batch size
            <select
              value={size}
              onChange={(event) => setSize(Number(event.target.value))}
              className={`${input} w-32`}
            >
              {[1, 5, 10, MAX_BATCH_SIZE].map((option) => (
                <option key={option} value={option}>
                  {option} {option === 1 ? "contact" : "contacts"}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!canSend} onClick={send} className={primaryButton}>
            {busy ? "Sending…" : `Send next ${size}`}
          </button>
          <p className="pb-3 text-[11px] text-[#8494A5]">
            Check the delivery and replies before sending the next batch.
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[#8B3F3F]">{error}</p>}

      {batch && (
        <div className="mt-5 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-4">
          <p className="text-sm font-semibold text-[#0B2A4A]">
            Last batch: {batch.sent} sent
            {batch.skipped > 0 && `, ${batch.skipped} skipped`}
            {batch.failed > 0 && `, ${batch.failed} failed`}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-[#526A80]">
            {batch.results.map((row) => (
              <li key={row.recipientId} className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-[#25313F]">{row.destination}</span>
                <span>
                  {STATUS_LABELS[row.status] ?? row.status}
                  {row.reason ? ` — ${row.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Composer({
  campaign,
  locked,
  businessName,
  onSaved,
}: {
  campaign: Campaign;
  locked: boolean;
  businessName: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject ?? "");
  const [body, setBody] = useState(campaign.body);
  const [allowRecontact, setAllowRecontact] = useState(campaign.allowRecontact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const unknown = unknownMergeFields(body);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await updateCampaignAction({
      campaignId: campaign.id,
      name,
      channel: campaign.channel,
      subject,
      body,
      allowRecontact,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSaved(true);
    onSaved();
  }

  return (
    <section className={card}>
      <h2 className={heading}>Message</h2>
      {locked ? (
        <p className={`mt-1 ${subtle}`}>
          Part of this campaign has already gone out, so the wording is locked. Create a new campaign
          to send something different.
        </p>
      ) : (
        <p className={`mt-1 ${subtle}`}>
          {"{{FirstName}}"} and {"{{Company}}"} are filled in per contact.
          {campaign.channel === "email"
            ? ` ${businessName}, your address and an unsubscribe link are added to the bottom of every email automatically.`
            : " The STOP line is required and cannot be removed."}
        </p>
      )}

      <label className={`mt-4 block ${label}`}>
        Campaign name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          className={input}
        />
      </label>

      {campaign.channel === "email" && (
        <label className={`mt-4 block ${label}`}>
          Subject line
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={locked}
            maxLength={200}
            className={input}
          />
        </label>
      )}

      <label className={`mt-4 block ${label}`}>
        Message
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={locked}
          rows={campaign.channel === "sms" ? 6 : 12}
          className={textarea}
        />
      </label>

      {unknown.length > 0 && (
        <p className="mt-2 text-sm text-[#8B3F3F]">
          Unknown placeholder{unknown.length > 1 ? "s" : ""}: {unknown.map((f) => `{{${f}}}`).join(", ")}
        </p>
      )}

      <label className="mt-4 flex items-start gap-2.5 text-sm text-[#42536A]">
        <input
          type="checkbox"
          checked={allowRecontact}
          onChange={(event) => setAllowRecontact(event.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          Allow contacts who were messaged in an earlier campaign
          <span className="block text-[11px] text-[#8494A5]">
            Off by default. Leave it off unless you mean to follow up with people you have already
            reached.
          </span>
        </span>
      </label>

      <div className="mt-5 flex items-center gap-3">
        <button type="button" disabled={busy} onClick={save} className={primaryButton}>
          {busy ? "Saving…" : "Save message"}
        </button>
        {saved && <span className="text-sm font-semibold text-[#2C6B45]">Saved</span>}
        {error && <span className="text-sm text-[#8B3F3F]">{error}</span>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function PreviewPanel({ campaign, recipients }: { campaign: Campaign; recipients: Recipient[] }) {
  const sample = recipients.find((r) => r.status === "pending") ?? recipients[0];
  const preview = renderOutreachBody(campaign.body, {
    firstName: sample?.firstName || "Dave",
    companyName: sample?.companyName || "Hamilton Plumbing",
  });
  const segments = campaign.channel === "sms" ? smsSegments(preview) : null;

  return (
    <section className={card}>
      <h2 className={heading}>Preview</h2>
      <p className={`mt-1 ${subtle}`}>
        {sample ? `As ${sample.firstName || "this contact"} will see it.` : "With sample values."}
      </p>

      {campaign.channel === "email" && campaign.subject && (
        <p className="mt-4 rounded-t-xl border border-b-0 border-[#E4EAF0] bg-[#F1F5F8] px-3.5 py-2.5 text-xs font-semibold text-[#42536A]">
          {campaign.subject}
        </p>
      )}
      <div
        className={`whitespace-pre-wrap break-words border border-[#E4EAF0] bg-[#F9FBFC] px-3.5 py-3 text-sm leading-6 text-[#25313F] ${
          campaign.channel === "email" && campaign.subject ? "rounded-b-xl" : "mt-4 rounded-xl"
        }`}
      >
        {preview}
      </div>

      {segments && (
        <div className="mt-3 space-y-1 text-[11px] text-[#6B7D90]">
          <p>
            {segments.characters} characters ·{" "}
            <span className={segments.segments > 3 ? "font-semibold text-[#8A681F]" : ""}>
              {segments.segments} segment{segments.segments === 1 ? "" : "s"}
            </span>{" "}
            · {segments.encoding}
          </p>
          {segments.encoding === "UCS-2" && (
            <p className="rounded-lg border border-[#E7C878] bg-[#FFF9E9] px-2.5 py-2 text-[#7A5F1E]">
              Special characters ({segments.nonGsmCharacters.slice(0, 6).join(" ")}) cut each segment
              to 70 characters. Replacing curly quotes and dashes with plain ones will cost less to
              send.
            </p>
          )}
        </div>
      )}
      {campaign.channel === "email" && (
        <p className="mt-3 text-[11px] text-[#8494A5]">
          Your business name, mailing address and a working unsubscribe link are appended to every
          email when it is sent.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function TestPanel({ campaign }: { campaign: Campaign }) {
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    setDetail(null);
    setSent(false);
    const result = await sendTestAction({ campaignId: campaign.id, destination });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setDetail(result.detail ?? null);
      return;
    }
    setSent(true);
  }

  return (
    <section className={card}>
      <h2 className={heading}>Test on yourself first</h2>
      <p className={`mt-1 ${subtle}`}>
        Send this exact message to your own {campaign.channel === "sms" ? "phone" : "inbox"} before
        anyone else gets it. Test sends do not touch the contact list.
      </p>
      <label className={`mt-4 block ${label}`}>
        {campaign.channel === "sms" ? "Your mobile number" : "Your email address"}
        <input
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder={campaign.channel === "sms" ? "905 555 1234" : "you@example.com"}
          className={input}
        />
      </label>
      <button type="button" disabled={busy || destination.trim().length < 3} onClick={send} className={`mt-4 ${secondaryButton}`}>
        {busy ? "Sending…" : "Send test"}
      </button>
      {sent && <p className="mt-3 text-sm font-semibold text-[#2C6B45]">Test sent.</p>}
      {error && <p className="mt-3 text-sm text-[#8B3F3F]">{error}</p>}
      {detail && <p className="mt-1 text-xs text-[#8B3F3F]">{detail}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ImportPanel({
  campaignId,
  channel,
  onImported,
}: {
  campaignId: string;
  channel: "email" | "sms";
  onImported: () => void;
}) {
  const [paste, setPaste] = useState("");
  const [consentBasis, setConsentBasis] = useState<string>("business_card");
  const [metOn, setMetOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    queued: number;
    created: number;
    matched: number;
    duplicates: number;
    invalid: number;
    skippedNoDestination: number;
    errors: { line: number; text: string; problem: string }[];
  } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setSummary(null);
    const result = await importContactsAction({ campaignId, paste, consentBasis, metOn });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSummary(result);
    setPaste("");
    onImported();
  }

  return (
    <section className={card}>
      <h2 className={heading}>Add contacts</h2>
      <p className={`mt-1 ${subtle}`}>
        One per line, or paste straight from a spreadsheet. Columns can be in any order if the first
        row names them: <span className="font-medium text-[#42536A]">First name, Company, Phone, Email</span>.
      </p>

      <label className={`mt-4 block ${label}`}>
        Contacts
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          rows={7}
          placeholder={"Dave, Hamilton Plumbing, 905 555 1234, dave@hamiltonplumbing.ca\nSarah, Ancaster Couriers, 289 555 8877"}
          className={`${textarea} font-mono text-[13px]`}
        />
      </label>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={label}>
          How did you get their details?
          <select
            value={consentBasis}
            onChange={(event) => setConsentBasis(event.target.value)}
            className={input}
          >
            {CONSENT_BASES.map((basis) => (
              <option key={basis.value} value={basis.value}>
                {basis.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          When did you meet them?
          <input type="date" value={metOn} onChange={(event) => setMetOn(event.target.value)} className={input} />
        </label>
      </div>

      <p className="mt-3 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] px-3.5 py-2.5 text-[11px] leading-5 text-[#6B7D90]">
        This is recorded against each contact as your basis for messaging them. Canadian anti-spam
        law needs it, so please only add people you actually met — a list bought or scraped from the
        web is not a consent basis, and there is no option here for one.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <button type="button" disabled={busy || paste.trim().length === 0} onClick={submit} className={primaryButton}>
          {busy ? "Adding…" : "Add to campaign"}
        </button>
        {error && <span className="text-sm text-[#8B3F3F]">{error}</span>}
      </div>

      {summary && (
        <div className="mt-4 rounded-xl border border-[#E4EAF0] bg-[#F9FBFC] p-4 text-sm text-[#42536A]">
          <p className="font-semibold text-[#0B2A4A]">
            {summary.queued} added to the campaign
          </p>
          <p className="mt-1 text-xs">
            {summary.created} new contact{summary.created === 1 ? "" : "s"} created ·{" "}
            {summary.matched} matched to someone already in your system
            {summary.duplicates > 0 && ` · ${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"} ignored`}
            {summary.skippedNoDestination > 0 &&
              ` · ${summary.skippedNoDestination} had no ${channel === "sms" ? "phone number" : "email address"}`}
          </p>
          {summary.errors.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-[#8B3F3F]">
              {summary.errors.slice(0, 12).map((row) => (
                <li key={`${row.line}-${row.problem}`}>
                  Line {row.line}: {row.problem}
                  {row.text ? ` — ${row.text.slice(0, 60)}` : ""}
                </li>
              ))}
              {summary.errors.length > 12 && <li>…and {summary.errors.length - 12} more.</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function RecipientTable({
  campaignId,
  recipients,
  onChanged,
}: {
  campaignId: string;
  recipients: Recipient[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingIds = recipients.filter((r) => r.status === "pending").map((r) => r.id);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await removeRecipientsAction({ campaignId, recipientIds: [...selected] });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSelected(new Set());
    onChanged();
  }

  return (
    <section className={card}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className={heading}>Contacts</h2>
          <p className={`mt-1 ${subtle}`}>{recipients.length} on this campaign</p>
        </div>
        {selected.size > 0 && (
          <button type="button" disabled={busy} onClick={remove} className={secondaryButton}>
            {busy ? "Removing…" : `Remove ${selected.size} selected`}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-[#8B3F3F]">{error}</p>}

      {recipients.length === 0 ? (
        <p className="mt-4 rounded-xl bg-[#F6F8FA] px-4 py-10 text-center text-sm text-[#687B8E]">
          No contacts yet. Add some above.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
              <tr>
                <th className="w-9 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all waiting contacts"
                    checked={pendingIds.length > 0 && pendingIds.every((id) => selected.has(id))}
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(pendingIds) : new Set())
                    }
                    className="h-4 w-4"
                  />
                </th>
                <th className="py-2 pr-3 font-semibold">Contact</th>
                <th className="py-2 pr-3 font-semibold">Destination</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 font-semibold">Reply</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBF0F5]">
              {recipients.map((recipient) => (
                <tr key={recipient.id}>
                  <td className="py-3">
                    {recipient.status === "pending" && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${recipient.firstName || recipient.destination}`}
                        checked={selected.has(recipient.id)}
                        onChange={() => toggle(recipient.id)}
                        className="h-4 w-4"
                      />
                    )}
                  </td>
                  <td className="py-3 pr-3">
                    <span className="block font-medium text-[#25313F]">
                      {recipient.leadId ? (
                        <Link href={`/admin/leads/${recipient.leadId}`} className="hover:underline">
                          {recipient.firstName || "—"}
                        </Link>
                      ) : recipient.customerId ? (
                        <Link href={`/admin/customers/${recipient.customerId}`} className="hover:underline">
                          {recipient.firstName || "—"}
                        </Link>
                      ) : (
                        recipient.firstName || "—"
                      )}
                    </span>
                    {recipient.companyName && (
                      <span className="block text-xs text-[#8494A5]">{recipient.companyName}</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-[#526A80]">{recipient.destination}</td>
                  <td className="py-3 pr-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[recipient.status] ?? STATUS_STYLES.pending}`}
                    >
                      {STATUS_LABELS[recipient.status] ?? recipient.status}
                    </span>
                    {recipient.sentAt && (
                      <span className="ml-2 text-[11px] text-[#8494A5]">{recipient.sentAt}</span>
                    )}
                    {recipient.skipReason && (
                      <span className="mt-1 block text-[11px] text-[#8B3F3F]">{recipient.skipReason}</span>
                    )}
                  </td>
                  <td className="py-3">
                    {recipient.replies.length === 0 ? (
                      <span className="text-xs text-[#A6B3C0]">—</span>
                    ) : (
                      <ul className="space-y-1">
                        {recipient.replies.map((reply) => (
                          <li
                            key={reply.id}
                            className={`rounded-lg px-2.5 py-1.5 text-xs ${
                              reply.kind === "opt_stop"
                                ? "bg-[#FDF4F4] text-[#8B3F3F]"
                                : "bg-[#F1F5F8] text-[#25313F]"
                            }`}
                          >
                            {reply.body.slice(0, 140)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
