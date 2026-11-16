import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { LeadStatusSelect } from "./status-select";
import { requirePageStaff } from "@/lib/auth/page";
import {
  LEAD_TOPICS,
  LEAD_TOPIC_LABELS,
  LEAD_TOPIC_TONES,
  REQUEST_FILTERS,
  REQUEST_FILTER_LABELS,
  callStatusLabel,
  leadTopic,
  matchesRequestFilter,
  needsCall,
  parseRequestFilter,
  parseTopic,
  sortForCalling,
  telHref,
  waitingLabel,
  type LeadTopic,
  type RequestFilter,
} from "@/lib/lead-topics";
import { formatPhone } from "@/lib/phone";
import { followUpCounts, isFollowUpDue, startOfLocalDay } from "@/lib/quote-follow-ups";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Newest rows read per tab. Filters and counts are worked out over these. */
const LOAD_LIMIT = 500;

type View = { tab: "leads" | "quotes"; filter: RequestFilter; topic: LeadTopic | null };

function viewHref(view: View): string {
  const params = new URLSearchParams();
  if (view.tab === "quotes") params.set("tab", "quotes");
  if (view.tab === "quotes" && view.filter !== "all") params.set("filter", view.filter);
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

function CallLink({ phone, className = "" }: { phone: string | null; className?: string }) {
  const href = telHref(phone);
  if (!href) return null;
  return (
    <a href={href} className={`font-medium text-accent-300 hover:underline ${className}`}>
      {formatPhone(phone)}
    </a>
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

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string; topic?: string }>;
}) {
  await requirePageStaff("manage_customers");
  const params = await searchParams;
  const view: View = {
    tab: params.tab === "quotes" ? "quotes" : "leads",
    filter: parseRequestFilter(params.filter),
    topic: parseTopic(params.topic),
  };
  const now = new Date();
  const { timezone: tz } = await getSettings();
  const day = (date: Date) => formatInZone(date, tz, { month: "short", day: "numeric" });

  const allLeads = await db().select().from(schema.leads).orderBy(desc(schema.leads.createdAt)).limit(LOAD_LIMIT);
  const requestRows = (
    await db()
      .select({ quote: schema.quoteRequests, lead: schema.leads })
      .from(schema.quoteRequests)
      .leftJoin(schema.leads, eq(schema.leads.id, schema.quoteRequests.leadId))
      .orderBy(desc(schema.quoteRequests.createdAt))
      .limit(LOAD_LIMIT)
  ).map((row) => ({
    ...row,
    topic: leadTopic({ kind: row.lead?.kind ?? "quote", attribution: row.lead?.attribution }),
  }));
  const leadRows = allLeads.map((lead) => ({ lead, topic: leadTopic(lead) }));

  // Each set of chips counts what is left once the OTHER chips are applied, so
  // a number is always what you get on clicking it.
  const topicOk = (topic: LeadTopic) => view.topic === null || view.topic === topic;
  const requestsForFilterCounts = requestRows.filter((r) => topicOk(r.topic));
  const requestsForTopicCounts = requestRows.filter((r) => matchesRequestFilter(r.quote, view.filter, now));
  const waitingCount = requestRows.filter((r) => needsCall(r.quote)).length;

  const visibleRequests = sortForCalling(
    requestsForFilterCounts.filter((r) => matchesRequestFilter(r.quote, view.filter, now)).map((r) => ({ ...r, ...r.quote })),
    now,
  );
  const visibleLeads = leadRows.filter((r) => topicOk(r.topic));
  const followUps = await followUpCounts(visibleRequests.slice(0, 200).map((r) => r.id));
  const todayStart = startOfLocalDay(tz, now);

  const topicCounts = (rows: { topic: LeadTopic }[]) => {
    const counts = new Map<LeadTopic, number>();
    for (const row of rows) counts.set(row.topic, (counts.get(row.topic) ?? 0) + 1);
    return counts;
  };
  const topicChips = (counts: Map<LeadTopic, number>, total: number) => (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      <Chip href={viewHref({ ...view, topic: null })} active={view.topic === null}>All topics ({total})</Chip>
      {LEAD_TOPICS.filter((topic) => (counts.get(topic) ?? 0) > 0 || view.topic === topic).map((topic) => (
        <Chip key={topic} href={viewHref({ ...view, topic })} active={view.topic === topic}>
          {LEAD_TOPIC_LABELS[topic]} ({counts.get(topic) ?? 0})
        </Chip>
      ))}
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Leads</h1>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={viewHref({ ...view, tab: "leads" })}
          className={`rounded-full px-4 py-1.5 text-sm ${view.tab === "leads" ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"}`}
        >
          All leads ({allLeads.length})
        </Link>
        <Link
          href={viewHref({ ...view, tab: "quotes" })}
          className={`rounded-full px-4 py-1.5 text-sm ${view.tab === "quotes" ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"}`}
        >
          Quote &amp; callback requests ({requestRows.length})
          {waitingCount > 0 && (
            <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-ink-950">
              {waitingCount} to call
            </span>
          )}
        </Link>
      </div>

      {view.tab === "leads" && (
        <>
          {topicChips(topicCounts(leadRows), leadRows.length)}
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <thead className="bg-ink-900 text-left text-ink-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Topic</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleLeads.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-500">No leads here.</td></tr>
                )}
                {visibleLeads.map(({ lead: l, topic }) => {
                  const attr = l.attribution;
                  return (
                    <tr key={l.id} className="border-t border-ink-800 align-top hover:bg-ink-900/40">
                      <td className="px-4 py-3">
                        <Link href={`/admin/leads/${l.id}`} className="font-medium text-white hover:text-accent-300 hover:underline">
                          {l.name}
                        </Link>
                        {l.message && <p className="mt-1 max-w-xs truncate text-xs text-ink-500">{l.message}</p>}
                      </td>
                      <td className="px-4 py-3 text-ink-300">
                        <CallLink phone={l.phone} className="block" />
                        {l.phone && !telHref(l.phone) && <p>{l.phone}</p>}
                        {l.email && <p>{l.email}</p>}
                      </td>
                      <td className="px-4 py-3"><TopicBadge topic={topic} /></td>
                      <td className="px-4 py-3 text-ink-400">
                        {(attr?.source as string) ?? "—"}
                        {attr?.promo && (
                          <span className="ml-2 rounded bg-emerald-950/40 px-1.5 py-0.5 text-xs text-emerald-300">
                            {attr.promo.code}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <LeadStatusSelect leadId={l.id} status={l.status} linkedToCustomer={Boolean(l.convertedCustomerId)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view.tab === "quotes" && (
        <div className="mt-6">
          <div className="flex flex-wrap gap-2 text-xs">
            {REQUEST_FILTERS.map((filter) => {
              const n = requestsForFilterCounts.filter((r) => matchesRequestFilter(r.quote, filter, now)).length;
              return (
                <Chip
                  key={filter}
                  href={viewHref({ ...view, filter })}
                  active={view.filter === filter}
                  tone={filter === "call" || filter === "due" ? "alert" : "default"}
                >
                  {REQUEST_FILTER_LABELS[filter]} ({n})
                </Chip>
              );
            })}
          </div>
          {topicChips(topicCounts(requestsForTopicCounts), requestsForTopicCounts.length)}

          <div className="mt-4 space-y-3">
            {visibleRequests.length === 0 && (
              <p className="text-ink-500">
                {view.filter === "call" ? "Everyone has been called." : view.filter === "due" ? "Nothing is due for a follow-up." : "No requests here."}
              </p>
            )}
            {visibleRequests.map((q) => {
              const lead = q.lead;
              const v = q.vehicleInfo;
              const due = isFollowUpDue(q, now);
              const uncalled = needsCall(q);
              const vehicle =
                [v?.year, v?.make, v?.model].filter(Boolean).join(" ") ||
                (v?.category && v.category in VEHICLE_CATEGORY_LABELS
                  ? VEHICLE_CATEGORY_LABELS[v.category as VehicleCategory]
                  : "Vehicle not specified");
              return (
                <div
                  key={q.id}
                  className={`rounded-xl border bg-ink-900/40 p-4 hover:border-accent-500/50 ${
                    uncalled ? "border-amber-500/60" : due ? "border-amber-500/40" : "border-ink-800"
                  }`}
                >
                  <Link href={`/admin/leads/quotes/${q.id}`} className="block">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="flex flex-wrap items-center gap-2 font-medium text-white">
                          {lead?.name ?? "Unknown"}
                          <TopicBadge topic={q.topic} />
                        </p>
                        <p className="text-sm text-ink-400">
                          {vehicle}
                          {" · "}received {day(q.createdAt)}
                        </p>
                      </div>
                      <StatusBadge status={q.status} />
                    </div>
                    {q.conditionDescription && (
                      <p className="mt-2 line-clamp-2 text-sm text-ink-500">{q.conditionDescription}</p>
                    )}
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
                      <span className={uncalled ? "font-semibold text-amber-300" : ""}>
                        {callStatusLabel(q, followUps.get(q.id) ?? 0, day)}
                      </span>
                      {uncalled && <span className="text-amber-300">{waitingLabel(q.createdAt, now)}</span>}
                      {q.nextFollowUpAt && q.status !== "closed" && !uncalled && (
                        <span className={due ? "font-semibold text-amber-300" : ""}>
                          {due
                            ? q.nextFollowUpAt < todayStart
                              ? `Follow-up overdue since ${day(q.nextFollowUpAt)}`
                              : "Follow-up due today"
                            : `Next follow-up ${day(q.nextFollowUpAt)}`}
                        </span>
                      )}
                    </p>
                  </Link>
                  {/* Outside the card's link: a phone link nested in another link is invalid, and the tap must dial. */}
                  {telHref(lead?.phone) && (
                    <p className="mt-3 border-t border-ink-800 pt-3 text-sm">
                      <span className="text-ink-500">Call </span>
                      <CallLink phone={lead?.phone ?? null} />
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
