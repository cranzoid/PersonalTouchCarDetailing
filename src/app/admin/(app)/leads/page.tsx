import Link from "next/link";
import { asc, count, desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { LeadStatusSelect } from "./status-select";
import { requirePageStaff } from "@/lib/auth/page";
import {
  followUpCounts,
  followUpDueWhere,
  isCallbackRequest,
  isFollowUpDue,
  startOfLocalDay,
} from "@/lib/quote-follow-ups";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  await requirePageStaff("manage_customers");
  const { tab, filter } = await searchParams;
  const activeTab = tab === "quotes" ? "quotes" : "leads";
  const dueOnly = filter === "due";

  const leads = await db().select().from(schema.leads).orderBy(desc(schema.leads.createdAt)).limit(100);
  const now = new Date();
  // The due view asks the database rather than filtering the newest 100, so
  // an old request that falls due is never hidden by newer ones.
  const quotes = dueOnly
    ? await db()
        .select()
        .from(schema.quoteRequests)
        .where(followUpDueWhere(now))
        .orderBy(asc(schema.quoteRequests.nextFollowUpAt))
        .limit(100)
    : await db()
        .select()
        .from(schema.quoteRequests)
        .orderBy(desc(schema.quoteRequests.createdAt))
        .limit(100);
  const [{ n: dueCount }] = await db()
    .select({ n: count() })
    .from(schema.quoteRequests)
    .where(followUpDueWhere(now));
  const quoteLeadIds = quotes.map((q) => q.leadId).filter((x): x is string => !!x);
  const quoteLeads =
    quoteLeadIds.length > 0
      ? await db().select().from(schema.leads).where(inArray(schema.leads.id, quoteLeadIds))
      : [];
  const leadById = new Map(quoteLeads.map((l) => [l.id, l]));
  const { timezone: tz } = await getSettings();
  const todayStart = startOfLocalDay(tz, now);
  const followUps = await followUpCounts(quotes.map((q) => q.id));
  const day = (date: Date) => formatInZone(date, tz, { month: "short", day: "numeric" });

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Leads</h1>
      <div className="mt-4 flex gap-2">
        <Link
          href="/admin/leads"
          className={`rounded-full px-4 py-1.5 text-sm ${activeTab === "leads" ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"}`}
        >
          All leads ({leads.length})
        </Link>
        <Link
          href="/admin/leads?tab=quotes"
          className={`rounded-full px-4 py-1.5 text-sm ${activeTab === "quotes" ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"}`}
        >
          Quote &amp; callback requests{dueOnly ? "" : ` (${quotes.length})`}
        </Link>
      </div>

      {activeTab === "leads" && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-ink-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-500">No leads yet.</td></tr>
              )}
              {leads.map((l) => {
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
                      {l.email && <p>{l.email}</p>}
                      {l.phone && <p>{l.phone}</p>}
                    </td>
                    <td className="px-4 py-3 capitalize text-ink-300">{l.kind}</td>
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
      )}

      {activeTab === "quotes" && (
        <div className="mt-6">
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              href="/admin/leads?tab=quotes"
              className={`rounded-full px-3 py-1 ${!dueOnly ? "bg-ink-700 font-semibold text-white" : "bg-ink-900 text-ink-400"}`}
            >
              All
            </Link>
            <Link
              href="/admin/leads?tab=quotes&filter=due"
              className={`rounded-full px-3 py-1 ${dueOnly ? "bg-amber-500/20 font-semibold text-amber-300" : "bg-ink-900 text-ink-400"}`}
            >
              Follow-up due ({dueCount})
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {quotes.length === 0 && (
              <p className="text-ink-500">{dueOnly ? "Nothing is due for a follow-up." : "No quote requests yet."}</p>
            )}
            {quotes.map((q) => {
              const lead = q.leadId ? leadById.get(q.leadId) : undefined;
              const v = q.vehicleInfo;
              const due = isFollowUpDue(q, now);
              const count = followUps.get(q.id) ?? 0;
              return (
                <Link
                  key={q.id}
                  href={`/admin/leads/quotes/${q.id}`}
                  className={`block rounded-xl border bg-ink-900/40 p-4 hover:border-accent-500/50 ${
                    due ? "border-amber-500/40" : "border-ink-800"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-white">
                        {lead?.name ?? "Unknown"}
                        {isCallbackRequest(lead?.attribution) && (
                          <span className="ml-2 rounded bg-sky-950/40 px-1.5 py-0.5 text-xs font-normal text-sky-300">
                            Callback
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-ink-400">
                        {[v?.year, v?.make, v?.model].filter(Boolean).join(" ") || "Vehicle not specified"}
                        {" · "}received {day(q.createdAt)}
                      </p>
                    </div>
                    <StatusBadge status={q.status} />
                  </div>
                  {q.conditionDescription && (
                    <p className="mt-2 line-clamp-2 text-sm text-ink-500">{q.conditionDescription}</p>
                  )}
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
                    <span>
                      {q.lastFollowedUpAt
                        ? `Last followed up ${day(q.lastFollowedUpAt)} · ${count} follow-up${count === 1 ? "" : "s"}`
                        : "Never followed up"}
                    </span>
                    {q.nextFollowUpAt && q.status !== "closed" && (
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
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
