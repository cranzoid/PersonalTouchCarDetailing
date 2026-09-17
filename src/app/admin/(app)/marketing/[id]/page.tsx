import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { withinSendWindow } from "@/lib/marketing/message";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { CampaignWorkspace } from "./campaign-workspace";

export const dynamic = "force-dynamic";

/**
 * One send: its wording, who it reached, and what came back.
 *
 * Picking who to message happens elsewhere now — on the Outreach screen for
 * people already in the system, and on the paste panel below for contacts who
 * are not. This page is the record of a send and the place to work through the
 * rest of a pasted batch.
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_marketing");
  const { id } = await params;

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

  // Replies from the people on this send, so the owner can see what came back
  // without leaving the screen they sent from. Keyed on the lead OR the
  // customer: a pasted contact is a lead, and a win-back recipient is a
  // customer who never was one.
  const leadIds = recipients.map((r) => r.leadId).filter((v): v is string => Boolean(v));
  const customerIds = recipients.map((r) => r.customerId).filter((v): v is string => Boolean(v));
  const replies =
    leadIds.length || customerIds.length
      ? await db()
          .select()
          .from(schema.communications)
          .where(
            or(
              leadIds.length ? inArray(schema.communications.leadId, leadIds) : undefined,
              customerIds.length ? inArray(schema.communications.customerId, customerIds) : undefined,
            ),
          )
          .orderBy(asc(schema.communications.createdAt))
      : [];
  const inboundByParty = new Map<string, typeof replies>();
  for (const reply of replies) {
    if (reply.direction !== "inbound") continue;
    for (const key of [reply.leadId, reply.customerId]) {
      if (!key) continue;
      inboundByParty.set(key, [...(inboundByParty.get(key) ?? []), reply]);
    }
  }

  const issues = checkCampaignCompliance({
    channel: campaign.channel as "email" | "sms",
    subject: campaign.subject,
    body: campaign.body,
    businessName: settings.businessName,
  });
  const window = withinSendWindow(new Date(), settings.timezone);

  return (
    <div className="max-w-[88rem]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/marketing/campaigns" className="text-xs font-semibold text-[#8A681F] hover:underline">
            ← All sends
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
          replies: (inboundByParty.get(r.leadId ?? r.customerId ?? "") ?? []).map((reply) => ({
            id: reply.id,
            body: reply.body,
            kind: reply.kind,
          })),
        }))}
        issues={issues}
        sendWindow={window}
        businessName={settings.businessName}
      />
    </div>
  );
}
