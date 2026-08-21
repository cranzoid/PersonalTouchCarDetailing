import Link from "next/link";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { looksLikeOptOutRequest } from "@/lib/marketing/inbound";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { CampaignCreateForm } from "./campaign-create-form";
import { card, heading, subtle } from "./ui";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-[#EEF2F6] text-[#4C5F73]",
  sending: "bg-[#FFF3D6] text-[#8A681F]",
  paused: "bg-[#FFF3D6] text-[#8A681F]",
  completed: "bg-[#E4F4EA] text-[#2C6B45]",
  cancelled: "bg-[#F6E8E8] text-[#8B3F3F]",
};

export default async function MarketingPage() {
  await requirePageStaff("manage_marketing");
  const settings = await getSettings();

  const campaigns = await db()
    .select()
    .from(schema.outreachCampaigns)
    .orderBy(desc(schema.outreachCampaigns.createdAt))
    .limit(50);

  const counts = campaigns.length
    ? await db()
        .select({
          campaignId: schema.outreachRecipients.campaignId,
          status: schema.outreachRecipients.status,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.outreachRecipients)
        .where(inArray(schema.outreachRecipients.campaignId, campaigns.map((c) => c.id)))
        .groupBy(schema.outreachRecipients.campaignId, schema.outreachRecipients.status)
    : [];
  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const entry = byCampaign.get(row.campaignId) ?? {};
    entry[row.status] = row.count;
    byCampaign.set(row.campaignId, entry);
  }

  const replies = await db()
    .select()
    .from(schema.communications)
    .where(eq(schema.communications.direction, "inbound"))
    .orderBy(desc(schema.communications.createdAt))
    .limit(15);

  const [{ suppressed = 0 } = { suppressed: 0 }] = await db()
    .select({ suppressed: sql<number>`count(*)::int` })
    .from(schema.marketingSuppressions);

  return (
    <div className="max-w-[88rem]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Outreach</p>
          <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Marketing campaigns</h1>
          <p className={`mt-1 ${subtle}`}>
            Text or email a list of contacts from your own number and address, in small batches you
            can check as you go.
          </p>
        </div>
        <Link
          href="/admin/marketing/do-not-contact"
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
        >
          Do-not-contact list
          <span className="rounded-full bg-[#EEF2F6] px-2 py-0.5 text-[10px] font-bold text-[#4C5F73]">{suppressed}</span>
        </Link>
      </header>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <CampaignCreateForm />

          <section className={`mt-6 ${card}`}>
            <h2 className={heading}>Campaigns</h2>
            {campaigns.length === 0 ? (
              <p className="mt-4 rounded-xl bg-[#F6F8FA] px-4 py-10 text-center text-sm text-[#687B8E]">
                No campaigns yet. Create one above to get started.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Campaign</th>
                      <th className="py-2 pr-3 font-semibold">Channel</th>
                      <th className="py-2 pr-3 font-semibold">Status</th>
                      <th className="py-2 pr-3 font-semibold">Sent</th>
                      <th className="py-2 pr-3 font-semibold">Waiting</th>
                      <th className="py-2 font-semibold">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EBF0F5]">
                    {campaigns.map((campaign) => {
                      const stats = byCampaign.get(campaign.id) ?? {};
                      return (
                        <tr key={campaign.id}>
                          <td className="py-3 pr-3">
                            <Link
                              href={`/admin/marketing/${campaign.id}`}
                              className="font-semibold text-[#0B2A4A] hover:underline"
                            >
                              {campaign.name}
                            </Link>
                          </td>
                          <td className="py-3 pr-3 uppercase text-[#526A80]">{campaign.channel}</td>
                          <td className="py-3 pr-3">
                            <span
                              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[campaign.status] ?? STATUS_STYLES.draft}`}
                            >
                              {campaign.status}
                            </span>
                          </td>
                          <td className="py-3 pr-3 font-semibold text-[#0B2A4A]">{stats.sent ?? 0}</td>
                          <td className="py-3 pr-3 text-[#526A80]">{stats.pending ?? 0}</td>
                          <td className="py-3 text-[#78889A]">
                            {formatInZone(campaign.createdAt, settings.timezone, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <section className={card}>
          <h2 className={heading}>Recent replies</h2>
          <p className={`mt-1 ${subtle}`}>
            Inbound texts to your Twilio number. STOP replies are added to the do-not-contact list
            automatically.
          </p>
          {replies.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#F6F8FA] px-4 py-8 text-center text-sm text-[#687B8E]">
              No replies yet.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {replies.map((reply) => {
                const flagged = reply.kind === "reply" && looksLikeOptOutRequest(reply.body);
                return (
                  <li
                    key={reply.id}
                    className={`rounded-xl border p-3 ${
                      reply.kind === "opt_stop"
                        ? "border-[#E7C0C0] bg-[#FDF4F4]"
                        : flagged
                          ? "border-[#E7C878] bg-[#FFF9E9]"
                          : "border-[#E4EAF0] bg-[#F9FBFC]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#42536A]">
                        {reply.customerId ? (
                          <Link href={`/admin/customers/${reply.customerId}`} className="hover:underline">
                            View customer
                          </Link>
                        ) : reply.leadId ? (
                          <Link href={`/admin/leads/${reply.leadId}`} className="hover:underline">
                            View lead
                          </Link>
                        ) : (
                          "Unmatched number"
                        )}
                      </span>
                      <span className="text-[10px] text-[#8494A5]">
                        {formatInZone(reply.createdAt, settings.timezone, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-[#25313F]">{reply.body}</p>
                    {reply.kind === "opt_stop" && (
                      <p className="mt-1.5 text-[11px] font-semibold text-[#8B3F3F]">Opted out — added to do-not-contact</p>
                    )}
                    {flagged && (
                      <p className="mt-1.5 text-[11px] font-semibold text-[#8A681F]">
                        Reads like an opt-out request — handle this by hand
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
