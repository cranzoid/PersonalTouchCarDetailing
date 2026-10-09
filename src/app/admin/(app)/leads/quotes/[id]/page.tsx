import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { QuoteStatusSelect } from "../../status-select";
import { requirePageStaff } from "@/lib/auth/page";
import { roleHas } from "@/lib/auth/permissions";
import { withinSendWindow } from "@/lib/marketing/message";
import { isSuppressed } from "@/lib/marketing/suppressions";
import { formatPhone } from "@/lib/phone";
import { DEFAULT_FOLLOW_UP_GAP_DAYS, FOLLOW_UP_METHODS, type FollowUpMethod } from "@/lib/quote-follow-up-message";
import {
  followUpBlock,
  isFollowUpDue,
  loadFollowUpWording,
  loadQuoteForFollowUp,
  startOfLocalDay,
  vehicleLabel,
} from "@/lib/quote-follow-ups";
import { describeMessage } from "@/lib/reply-message";
import { formatInZone, localDateISO } from "@/lib/tz";
import { FollowUpPanel } from "./follow-up-panel";

export const dynamic = "force-dynamic";

type TimelineItem = {
  id: string;
  at: Date;
  title: string;
  by: string | null;
  body: string | null;
  subject?: string | null;
  tone: "follow_up" | "comment" | "message" | "inbound" | "created";
};

const TONES: Record<TimelineItem["tone"], string> = {
  follow_up: "border-emerald-500/60",
  comment: "border-accent-400",
  message: "border-ink-700",
  inbound: "border-sky-500/60",
  created: "border-ink-700",
};

export default async function QuoteRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requirePageStaff("manage_estimates");
  const { id } = await params;
  const context = await loadQuoteForFollowUp(id);
  if (!context) notFound();
  const { quote, lead, services: requestedServices, settings, values, callback } = context;
  const tz = settings.timezone;
  const now = new Date();

  const photos = await db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.entityType, "quote_request"), eq(schema.files.entityId, id)));

  const activities = await db()
    .select({
      id: schema.quoteRequestActivities.id,
      kind: schema.quoteRequestActivities.kind,
      method: schema.quoteRequestActivities.method,
      body: schema.quoteRequestActivities.body,
      communicationId: schema.quoteRequestActivities.communicationId,
      createdAt: schema.quoteRequestActivities.createdAt,
      staffName: schema.staffUsers.name,
      messageSubject: schema.communications.subject,
      messageBody: schema.communications.body,
      messageStatus: schema.communications.status,
    })
    .from(schema.quoteRequestActivities)
    .leftJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.quoteRequestActivities.staffId))
    .leftJoin(schema.communications, eq(schema.communications.id, schema.quoteRequestActivities.communicationId))
    .where(eq(schema.quoteRequestActivities.quoteRequestId, quote.id))
    .orderBy(desc(schema.quoteRequestActivities.createdAt));
  // Everything else said to or by this person — the automatic acknowledgement,
  // their replies — so the history reads as one conversation.
  const followUpMessageIds = new Set(activities.map((a) => a.communicationId).filter(Boolean));
  const messages = lead
    ? (
        await db()
          .select({
            id: schema.communications.id,
            direction: schema.communications.direction,
            channel: schema.communications.channel,
            kind: schema.communications.kind,
            subject: schema.communications.subject,
            body: schema.communications.body,
            status: schema.communications.status,
            createdAt: schema.communications.createdAt,
            staffName: schema.staffUsers.name,
          })
          .from(schema.communications)
          .leftJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.communications.createdByStaffId))
          .where(eq(schema.communications.leadId, lead.id))
          .orderBy(desc(schema.communications.createdAt))
          .limit(50)
      ).filter((m) => !followUpMessageIds.has(m.id))
    : [];

  const timeline: TimelineItem[] = [
    ...activities.map((a): TimelineItem => {
      if (a.kind === "comment") {
        return { id: a.id, at: a.createdAt, title: "Comment", by: a.staffName, body: a.body, tone: "comment" };
      }
      const label = FOLLOW_UP_METHODS[a.method as FollowUpMethod] ?? "Follow-up";
      return {
        id: a.id,
        at: a.createdAt,
        title: `Follow-up · ${label}`,
        by: a.staffName,
        subject: a.messageSubject,
        // A sent email's stored body carries the compliance footer; the note
        // a person typed is what matters on a logged one.
        body: a.messageBody ? stripFooter(a.messageBody) : a.body,
        tone: "follow_up",
      };
    }),
    ...messages.map(
      (m): TimelineItem => ({
        id: m.id,
        at: m.createdAt,
        // A failed attempt is kept on record, and must not read as delivered.
        title: `${m.channel === "sms" ? "Text" : m.channel === "email" ? "Email" : m.channel} · ${describeMessage(m)}${
          m.status === "failed" ? " — not sent" : ""
        }`,
        by: m.direction === "inbound" ? null : m.staffName,
        subject: m.subject,
        body: stripFooter(m.body),
        tone: m.direction === "inbound" ? "inbound" : "message",
      }),
    ),
    {
      id: "created",
      at: quote.createdAt,
      title: callback ? "Callback requested" : "Quote requested",
      by: null,
      body: null,
      tone: "created" as const,
    },
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const followUpCount = activities.filter((a) => a.kind === "follow_up").length;
  const due = isFollowUpDue(quote, now);
  const overdue = due && quote.nextFollowUpAt! < startOfLocalDay(tz, now);

  const blocked = lead
    ? {
        sms: followUpBlock({
          channel: "sms",
          lead,
          requestedAt: quote.createdAt,
          now,
          suppressed: lead.phone ? await isSuppressed("sms", lead.phone) : false,
        }),
        email: followUpBlock({
          channel: "email",
          lead,
          requestedAt: quote.createdAt,
          now,
          suppressed: lead.email ? await isSuppressed("email", lead.email) : false,
        }),
      }
    : { sms: "There is no contact on this request.", email: "There is no contact on this request." };

  const v = quote.vehicleInfo;
  const kindLabel = callback ? "Callback request" : "Quote request";
  const dateLabel = (date: Date) => formatInZone(date, tz, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{quote.id}</p>
          <h1 className="text-2xl font-bold text-white">
            {kindLabel} — {lead?.name ?? "Unknown"}
          </h1>
          <p className="mt-1 text-sm text-ink-400">Received {dateLabel(quote.createdAt)}</p>
        </div>
        <QuoteStatusSelect quoteRequestId={quote.id} status={quote.status} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-ink-800 p-4">
          <p className="text-xs text-ink-500">Last followed up</p>
          <p className="mt-1 font-semibold text-white">
            {quote.lastFollowedUpAt
              ? formatInZone(quote.lastFollowedUpAt, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
              : "Never"}
          </p>
        </div>
        <div className="rounded-xl border border-ink-800 p-4">
          <p className="text-xs text-ink-500">Follow-ups</p>
          <p className="mt-1 font-semibold text-white">{followUpCount}</p>
        </div>
        <div
          className={`rounded-xl border p-4 ${
            due ? "border-amber-500/40 bg-amber-950/20" : "border-ink-800"
          }`}
        >
          <p className="text-xs text-ink-500">Next follow-up</p>
          <p className={`mt-1 font-semibold ${due ? "text-amber-300" : "text-white"}`}>
            {quote.nextFollowUpAt ? dateLabel(quote.nextFollowUpAt) : "Not scheduled"}
            {due && <span className="ml-2 text-xs">{overdue ? "Overdue" : "Due today"}</span>}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Contact</h2>
          {lead ? (
            <div className="mt-2 space-y-1 text-ink-300">
              <Link href={`/admin/leads/${lead.id}`} className="font-medium text-white hover:text-accent-300 hover:underline">
                {lead.name}
              </Link>
              {lead.email && <a className="block hover:text-accent-300" href={`mailto:${lead.email}`}>{lead.email}</a>}
              {lead.phone && <a className="block hover:text-accent-300" href={`tel:${lead.phone}`}>{formatPhone(lead.phone)}</a>}
              {lead.notes && <p className="text-xs text-accent-300">{lead.notes}</p>}
            </div>
          ) : (
            <p className="mt-2 text-ink-500">No lead record</p>
          )}
        </section>
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Vehicle</h2>
          <p className="mt-2 text-ink-300">
            {vehicleLabel(v) || "Not specified"}
            {v?.category ? ` · ${v.category}` : ""}
          </p>
        </section>
      </div>

      {lead && (
        <FollowUpPanel
          quoteRequestId={quote.id}
          contact={{ phone: lead.phone ? formatPhone(lead.phone) : null, email: lead.email }}
          blocked={blocked}
          smsWindow={withinSendWindow(now, tz)}
          values={values}
          businessName={settings.businessName}
          wording={await loadFollowUpWording()}
          canSaveDefault={roleHas(staff.role, "manage_settings")}
          schedule={{
            next: quote.nextFollowUpAt ? localDateISO(tz, 0, quote.nextFollowUpAt.getTime()) : null,
            suggested: localDateISO(tz, DEFAULT_FOLLOW_UP_GAP_DAYS * 86_400_000, now.getTime()),
          }}
        />
      )}

      <section className="mt-6 rounded-xl border border-ink-800 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Activity</h2>
        <div className="mt-4 space-y-4">
          {timeline.map((item) => (
            <div key={item.id} className={`border-l-2 pl-4 text-sm ${TONES[item.tone]}`}>
              <div className="flex flex-wrap justify-between gap-2">
                <p className="font-medium text-ink-200">
                  {item.title}
                  {item.by && <span className="font-normal text-ink-500"> · {item.by}</span>}
                </p>
                <time className="text-xs text-ink-500">
                  {formatInZone(item.at, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </time>
              </div>
              {item.subject && <p className="mt-1 text-ink-300">{item.subject}</p>}
              {item.body && <p className="mt-1 whitespace-pre-wrap text-ink-400">{item.body}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Requested services</h2>
        {requestedServices.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {requestedServices.map((s) => (
              <span key={s.id} className="rounded-full bg-ink-800 px-3 py-1 text-ink-200">{s.name}</span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-ink-500">None selected</p>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Condition description</h2>
        <p className="mt-2 whitespace-pre-wrap text-ink-300">{quote.conditionDescription ?? "—"}</p>
      </section>

      {photos.length > 0 && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Photos ({photos.length}) — private, staff-only
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={p.id} href={`/api/files/${p.id}`} target="_blank">
                <img
                  src={`/api/files/${p.id}`}
                  alt="Customer-submitted vehicle photo"
                  className="aspect-[4/3] w-full rounded-lg border border-ink-800 object-cover"
                />
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="mt-8">
        {quote.estimateId ? (
          <Link
            href={`/admin/estimates/${quote.estimateId}`}
            className="inline-block rounded-lg border border-ink-600 px-5 py-2.5 text-sm text-ink-200 hover:border-accent-400"
          >
            View Estimate →
          </Link>
        ) : (
          <Link
            href={`/admin/estimates/new?quoteRequest=${quote.id}`}
            className="inline-block rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent-300"
          >
            Create Estimate
          </Link>
        )}
      </div>
    </div>
  );
}

/** The system-appended CASL footer, which is noise in a history view. */
function stripFooter(body: string): string {
  const at = body.indexOf("\n\n—\n");
  return at === -1 ? body : body.slice(0, at);
}
