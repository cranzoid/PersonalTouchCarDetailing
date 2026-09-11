import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import {
  describeFooting,
  findMissedAppointments,
  type AudienceFilter,
} from "@/lib/marketing/audience";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { withinSendWindow } from "@/lib/marketing/message";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { formatCents } from "@/lib/money";
import type { AudienceFilterValue } from "./audience-panel";
import { CampaignWorkspace } from "./campaign-workspace";

export const dynamic = "force-dynamic";

const AUDIENCE_FILTERS = new Set<AudienceFilterValue>(["missed", "cancelled", "no_show"]);
const AUDIENCE_WINDOWS = new Set([30, 90, 180, 365]);

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageStaff("manage_marketing");
  const { id } = await params;
  const query = await searchParams;

  const [campaign] = await db()
    .select()
    .from(schema.outreachCampaigns)
    .where(eq(schema.outreachCampaigns.id, id))
    .limit(1);
  if (!campaign) notFound();

  const settings = await getSettings();
  const recipients = await db()
    .select()
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.campaignId, campaign.id))
    .orderBy(asc(schema.outreachRecipients.createdAt));

  // Replies from the people on this campaign, so the owner can see what came
  // back without leaving the screen they sent from.
  const leadIds = recipients.map((r) => r.leadId).filter((v): v is string => Boolean(v));
  const replies = leadIds.length
    ? await db()
        .select()
        .from(schema.communications)
        .where(
          inArray(schema.communications.leadId, leadIds),
        )
        .orderBy(asc(schema.communications.createdAt))
    : [];
  const inboundByLead = new Map<string, typeof replies>();
  for (const reply of replies) {
    if (reply.direction !== "inbound" || !reply.leadId) continue;
    inboundByLead.set(reply.leadId, [...(inboundByLead.get(reply.leadId) ?? []), reply]);
  }

  const issues = checkCampaignCompliance({
    channel: campaign.channel as "email" | "sms",
    subject: campaign.subject,
    body: campaign.body,
    businessName: settings.businessName,
  });
  const window = withinSendWindow(new Date(), settings.timezone);

  // Filters arrive from the URL so the list is rebuilt server-side on every
  // change — the reason, the consent footing and the do-not-contact state are
  // exactly the facts that must not be served from a client-side cache.
  const rawFilter = typeof query.audience === "string" ? query.audience : "missed";
  const audienceFilter = (AUDIENCE_FILTERS.has(rawFilter as AudienceFilterValue)
    ? rawFilter
    : "missed") as AudienceFilterValue;
  const rawDays = Number(typeof query.days === "string" ? query.days : "90");
  const withinDays = AUDIENCE_WINDOWS.has(rawDays) ? rawDays : 90;

  const audience = await findMissedAppointments({
    filter: audienceFilter as AudienceFilter,
    channel: campaign.channel as "email" | "sms",
    withinDays,
    timezone: settings.timezone,
  });

  return (
    <div className="max-w-[88rem]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/marketing" className="text-xs font-semibold text-[#8A681F] hover:underline">
            ← All campaigns
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">{campaign.name}</h1>
          <p className="mt-1 text-xs leading-5 text-[#5A6B7D]">
            {campaign.channel === "sms" ? "Text message" : "Email"} campaign · created{" "}
            {formatInZone(campaign.createdAt, settings.timezone, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
      </header>

      <CampaignWorkspace
        campaign={{
          id: campaign.id,
          name: campaign.name,
          channel: campaign.channel as "email" | "sms",
          subject: campaign.subject,
          body: campaign.body,
          bodyHtml: campaign.bodyHtml,
          status: campaign.status,
          allowRecontact: campaign.allowRecontact,
        }}
        recipients={recipients.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          customerId: r.customerId,
          destination: r.destination,
          firstName: r.firstName,
          companyName: r.companyName,
          status: r.status,
          skipReason: r.skipReason,
          contextNote: r.contextNote,
          sentAt: r.sentAt
            ? formatInZone(r.sentAt, settings.timezone, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : null,
          replies: (r.leadId ? (inboundByLead.get(r.leadId) ?? []) : []).map((reply) => ({
            id: reply.id,
            body: reply.body,
            kind: reply.kind,
          })),
        }))}
        issues={issues}
        sendWindow={window}
        businessName={settings.businessName}
        audience={{
          filter: audienceFilter,
          withinDays,
          totals: audience.totals,
          rows: audience.candidates.map((c) => ({
            appointmentId: c.appointmentId,
            customerId: c.customerId,
            name: [c.firstName, c.companyName].filter(Boolean).join(" · "),
            destination: c.destination,
            outcome: c.outcome,
            reason: c.reason,
            missedOnLabel: c.missedOnLabel,
            services: c.services,
            total: formatCents(c.totalCents, settings.currency),
            footingLabel: describeFooting(c.footing),
            blockedReason: c.blockedReason,
            alreadyContacted: c.alreadyContacted,
          })),
        }}
      />
    </div>
  );
}
