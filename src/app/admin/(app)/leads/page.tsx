import Link from "next/link";
import { desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { LeadStatusSelect } from "./status-select";
import { requirePageStaff } from "@/lib/auth/page";
import {
  LEAD_FILTERS,
  LEAD_FILTER_LABELS,
  LEAD_TOPICS,
  LEAD_TOPIC_LABELS,
  LEAD_TOPIC_TONES,
  callStatusLabel,
  isFollowUpDueFor,
  leadTopic,
  matchesLeadFilter,
  parseLeadFilter,
  parseTopic,
  telHref,
  type LeadFilter,
  type LeadTopic,
} from "@/lib/lead-topics";
import { formatPhone } from "@/lib/phone";
import { followUpCounts, startOfLocalDay } from "@/lib/quote-follow-ups";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Newest leads read. Filters and counts are worked out over these. */
const LOAD_LIMIT = 500;

type View = { filter: LeadFilter; topic: LeadTopic | null };

function viewHref(view: View): string {
  const params = new URLSearchParams();
  if (view.filter !== "all") params.set("filter", view.filter);
  if (view.topic) params.set("topic", view.topic);
  const query = params.toString();
  return query ? `/admin/leads?${query}` : "/admin/leads";
}

function TopicBadge({ topic }: { topic: LeadTopic }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${LEAD_TOPIC_TONES[topic]}`}>
      {LEAD_TOPIC_LABELS[topic]}
    </span>
  );
}

function Chip({ href, active, tone = "default", children }: {
  href: string;
  active: boolean;
  tone?: "default" | "alert";
  children: React.ReactNode;
}) {
  const on = tone === "alert" ? "bg-amber-500/20 font-semibold text-amber-300" : "bg-ink-700 font-semibold text-white";
  return (
    <Link href={href} className={`rounded-full px-3 py-1 ${active ? on : "bg-ink-900 text-ink-400 hover:text-ink-200"}`}>
      {children}
    </Link>
  );
}

function vehicleText(info: { year?: number; make?: string; model?: string; category?: string } | null): string | null {
  const named = [info?.year, info?.make, info?.model].filter(Boolean).join(" ");
  if (named) return named;
  if (info?.category && info.category in VEHICLE_CATEGORY_LABELS) {
    return VEHICLE_CATEGORY_LABELS[info.category as VehicleCategory];
  }
  return null;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; topic?: string }>;
}) {
  await requirePageStaff("manage_customers");
  const params = await searchParams;
  const view: View = { filter: parseLeadFilter(params.filter), topic: parseTopic(params.topic) };
  const now = new Date();
  const { timezone: tz } = await getSettings();
  const day = (date: Date) => formatInZone(date, tz, { month: "short", day: "numeric" });
  const todayStart = startOfLocalDay(tz, now);

  // Newest first: the list reads like an inbox, with today's enquiries on top.
  const leads = await db().select().from(schema.leads).orderBy(desc(schema.leads.createdAt)).limit(LOAD_LIMIT);
  const requests = leads.length
    ? await db()
        .select()
        .from(schema.quoteRequests)
        .where(inArray(schema.quoteRequests.leadId, leads.map((lead) => lead.id)))
        .orderBy(desc(schema.quoteRequests.createdAt))
    : [];
  // A lead's newest request is the one its call log opens on.
  const latestRequest = new Map<string, (typeof requests)[number]>();
  for (const request of requests) {
    if (request.leadId && !latestRequest.has(request.leadId)) latestRequest.set(request.leadId, request);
  }

  const rows = leads.map((lead) => {
    const request = latestRequest.get(lead.id) ?? null;
    return {
      lead,
      request,
      topic: leadTopic(lead),
      queue: { status: lead.status, nextFollowUpAt: request?.nextFollowUpAt ?? null },
    };
  });

  // Each set of chips counts what is left once the OTHER chips are applied, so
  // a number is always what you get on clicking it.
  const topicOk = (topic: LeadTopic) => view.topic === null || view.topic === topic;
  const rowsForFilterCounts = rows.filter((row) => topicOk(row.topic));
  const rowsForTopicCounts = rows.filter((row) => matchesLeadFilter(row.queue, view.filter, now));
  const visible = rowsForFilterCounts.filter((row) => matchesLeadFilter(row.queue, view.filter, now));
  const followUps = await followUpCounts(visible.flatMap((row) => (row.request ? [row.request.id] : [])));

  const topicCounts = new Map<LeadTopic, number>();
  for (const row of rowsForTopicCounts) topicCounts.set(row.topic, (topicCounts.get(row.topic) ?? 0) + 1);

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Leads</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-400">
        Everyone who has asked about us, newest first. Each lead has one status. It is the same here, on the
        lead&apos;s page and in their call log, so changing it in one place changes it everywhere. Open a lead&apos;s{" "}
        <span className="text-ink-200">call log</span> to log a call, send a follow-up, or see what was said last.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {LEAD_FILTERS.map((filter) => {
          const n = rowsForFilterCounts.filter((row) => matchesLeadFilter(row.queue, filter, now)).length;
          if (n === 0 && filter !== "all" && filter !== "new" && view.filter !== filter) return null;
          return (
            <Chip
              key={filter}
              href={viewHref({ ...view, filter })}
              active={view.filter === filter}
              tone={filter === "new" || filter === "due" ? "alert" : "default"}
            >
              {LEAD_FILTER_LABELS[filter]} ({n})
            </Chip>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <Chip href={viewHref({ ...view, topic: null })} active={view.topic === null}>
          All topics ({rowsForTopicCounts.length})
        </Chip>
        {LEAD_TOPICS.filter((topic) => (topicCounts.get(topic) ?? 0) > 0 || view.topic === topic).map((topic) => (
          <Chip key={topic} href={viewHref({ ...view, topic })} active={view.topic === topic}>
            {LEAD_TOPIC_LABELS[topic]} ({topicCounts.get(topic) ?? 0})
          </Chip>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {visible.length === 0 && (
          <p className="text-ink-500">
            {view.filter === "new"
              ? "Everyone has been called."
              : view.filter === "due"
                ? "Nothing is due for a follow-up."
                : "No leads here."}
          </p>
        )}
        {visible.map(({ lead, request, topic, queue }) => {
          const isNew = lead.status === "new";
          const due = isFollowUpDueFor(queue, now);
          const callLog = request ? `/admin/leads/quotes/${request.id}` : null;
          const vehicle = vehicleText(request?.vehicleInfo ?? null);
          const source = typeof lead.attribution?.source === "string" ? lead.attribution.source : null;
          const snippet = request?.conditionDescription ?? lead.message;
          const phoneHref = telHref(lead.phone);
          return (
            <div
              key={lead.id}
              className={`rounded-xl border bg-ink-900/40 p-4 ${
                isNew ? "border-amber-500/60" : due ? "border-amber-500/40" : "border-ink-800"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-white">
                    <Link href={callLog ?? `/admin/leads/${lead.id}`} className="hover:text-accent-300 hover:underline">
                      {lead.name}
                    </Link>
                    <TopicBadge topic={topic} />
                    {lead.attribution?.promo && (
                      <span className="rounded bg-emerald-950/40 px-1.5 py-0.5 text-xs text-emerald-300">
                        {lead.attribution.promo.code}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-400">
                    Received {day(lead.createdAt)}
                    {vehicle && ` · ${vehicle}`}
                    {source && ` · via ${source}`}
                  </p>
                </div>
                <LeadStatusSelect
                  leadId={lead.id}
                  status={lead.status}
                  linkedToCustomer={Boolean(lead.convertedCustomerId)}
                />
              </div>

              {snippet && <p className="mt-2 line-clamp-2 text-sm text-ink-500">{snippet}</p>}

              {request && (
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
                  <span className={isNew ? "font-semibold text-amber-300" : ""}>
                    {callStatusLabel(request, followUps.get(request.id) ?? 0, day)}
                  </span>
                  {!isNew && request.nextFollowUpAt && !due && lead.status !== "completed" && lead.status !== "lost" && (
                    <span>Next follow-up {day(request.nextFollowUpAt)}</span>
                  )}
                  {due && request.nextFollowUpAt && (
                    <span className="font-semibold text-amber-300">
                      {request.nextFollowUpAt < todayStart
                        ? `Follow-up overdue since ${day(request.nextFollowUpAt)}`
                        : "Follow-up due today"}
                    </span>
                  )}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 pt-3 text-sm">
                {phoneHref ? (
                  <a href={phoneHref} className="font-medium text-accent-300 hover:underline">
                    Call {formatPhone(lead.phone)}
                  </a>
                ) : (
                  lead.phone && <span className="text-ink-300">{lead.phone}</span>
                )}
                {lead.email && <span className="text-ink-400">{lead.email}</span>}
                <span className="ml-auto flex flex-wrap gap-x-4 gap-y-1">
                  {callLog && (
                    <Link href={callLog} className="font-medium text-accent-300 hover:underline">
                      Call log &amp; follow-ups →
                    </Link>
                  )}
                  <Link href={`/admin/leads/${lead.id}`} className="text-ink-300 hover:text-accent-300 hover:underline">
                    Lead details →
                  </Link>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
