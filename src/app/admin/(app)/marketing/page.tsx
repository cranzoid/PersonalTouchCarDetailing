import Link from "next/link";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { describeFooting, findMissedAudience } from "@/lib/marketing/audience";
import { withinSendWindow } from "@/lib/marketing/message";
import { outreachProviderReady } from "@/lib/marketing/winback";
import {
  defaultWinbackEmailBody,
  defaultWinbackEmailSubject,
  defaultWinbackSms,
  WINBACK_TEMPLATE_KEYS,
} from "@/lib/marketing/winback-message";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { OutreachWorkspace, type OutreachHistoryItem, type OutreachRow } from "./outreach-workspace";
import { subtle } from "./ui";

export const dynamic = "force-dynamic";

const AUDIENCE_WINDOWS = new Set([30, 90, 180, 365]);

/**
 * Outreach.
 *
 * One screen: everyone whose booking was cancelled or who never turned up,
 * what has already been said to each of them, and a composer for texting or
 * emailing the ones the owner picks. The same shape as first-wash nudges,
 * which is the screen this was rebuilt to match — see lib/marketing/winback.ts
 * for what the old four-step campaign builder was doing that this still does.
 *
 * How far back to look stays in the URL, because it changes the database query
 * — and the consent footing, the do-not-contact state and "have we messaged
 * them already" are exactly the facts that must not come from a client cache.
 * Cancelled-versus-no-show does not: both are already on the page, so that one
 * filters instantly instead of costing a round trip.
 */
export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageStaff("manage_marketing");
  const query = await searchParams;
  const settings = await getSettings();

  const rawDays = Number(typeof query.days === "string" ? query.days : "90");
  const withinDays = AUDIENCE_WINDOWS.has(rawDays) ? rawDays : 90;

  const audience = await findMissedAudience({
    filter: "missed",
    withinDays,
    timezone: settings.timezone,
  });

  // Everything already said to these people — campaign messages, their
  // replies, the automatic reminders — so nobody writes a second "sorry we
  // missed you" on top of one sent last week.
  const customerIds = [...new Set(audience.rows.map((row) => row.customerId))];
  const messages = customerIds.length
    ? await db()
        .select({
          id: schema.communications.id,
          customerId: schema.communications.customerId,
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
        .where(inArray(schema.communications.customerId, customerIds))
        .orderBy(desc(schema.communications.createdAt))
    : [];
  const historyByCustomer = new Map<string, OutreachHistoryItem[]>();
  for (const message of messages) {
    if (!message.customerId) continue;
    const list = historyByCustomer.get(message.customerId) ?? [];
    if (list.length >= 20) continue;
    list.push({
      id: message.id,
      atLabel: formatInZone(message.createdAt, settings.timezone, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      channel: message.channel,
      label: historyLabel(message),
      status: message.status,
      subject: message.subject,
      preview: message.body.length > 320 ? `${message.body.slice(0, 320)}…` : message.body,
      staffName: message.staffName,
    });
    historyByCustomer.set(message.customerId, list);
  }

  const [templates, smsReady, emailReady, [{ suppressed = 0 } = { suppressed: 0 }], sends] =
    await Promise.all([
      db()
        .select()
        .from(schema.messageTemplates)
        .where(
          inArray(schema.messageTemplates.key, [
            WINBACK_TEMPLATE_KEYS.sms,
            WINBACK_TEMPLATE_KEYS.email,
          ]),
        ),
      outreachProviderReady("sms"),
      outreachProviderReady("email"),
      db().select({ suppressed: sql<number>`count(*)::int` }).from(schema.marketingSuppressions),
      db()
        .select()
        .from(schema.outreachCampaigns)
        .orderBy(desc(schema.outreachCampaigns.createdAt))
        .limit(8),
    ]);
  const smsTemplate = templates.find((t) => t.key === WINBACK_TEMPLATE_KEYS.sms);
  const emailTemplate = templates.find((t) => t.key === WINBACK_TEMPLATE_KEYS.email);

  const sentCounts = sends.length
    ? await db()
        .select({
          campaignId: schema.outreachRecipients.campaignId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.outreachRecipients)
        .where(
          inArray(
            schema.outreachRecipients.campaignId,
            sends.map((c) => c.id),
          ),
        )
        .groupBy(schema.outreachRecipients.campaignId)
    : [];
  const sentByCampaign = new Map(sentCounts.map((row) => [row.campaignId, row.count]));

  const rows: OutreachRow[] = audience.rows.map((row) => ({
    appointmentId: row.appointmentId,
    customerId: row.customerId,
    name: [row.firstName, row.companyName].filter(Boolean).join(" · ") || "Customer",
    firstName: row.firstName,
    companyName: row.companyName,
    phone: row.sms.destination ? formatPhone(row.sms.destination) : null,
    email: row.email.destination || null,
    outcome: row.outcome,
    reason: row.reason,
    missedOnLabel: row.missedOnLabel,
    services: row.services,
    total: formatCents(row.totalCents, settings.currency),
    footingLabel: describeFooting(row.footing),
    blockedSms: row.sms.blockedReason,
    blockedEmail: row.email.blockedReason,
    contactedSms: row.sms.alreadyContacted,
    contactedEmail: row.email.alreadyContacted,
    history: historyByCustomer.get(row.customerId) ?? [],
  }));

  return (
    <div className="max-w-[92rem]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Outreach</p>
          <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Win back the ones who didn&rsquo;t come in</h1>
          <p className={`mt-1 max-w-3xl ${subtle}`}>
            Everyone whose booking was cancelled or who never turned up, with the reason they gave.
            Pick the people you want, check the message, and send it by text or email. Nobody is
            messaged twice, anyone who replied STOP is skipped, and the address and unsubscribe link
            are added for you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/marketing/campaigns"
            className="inline-flex min-h-10 items-center rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
          >
            Pasted lists &amp; fleet campaigns
          </Link>
          <Link
            href="/admin/marketing/do-not-contact"
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
          >
            Do-not-contact
            <span className="rounded-full bg-[#EEF2F6] px-2 py-0.5 text-[10px] font-bold text-[#4C5F73]">
              {suppressed}
            </span>
          </Link>
        </div>
      </header>

      <OutreachWorkspace
        rows={rows}
        withinDays={withinDays}
        totals={audience.totals}
        businessName={settings.businessName}
        sendWindow={withinSendWindow(new Date(), settings.timezone)}
        providerReady={{ sms: smsReady, email: emailReady }}
        templates={{
          sms: smsTemplate?.body ?? defaultWinbackSms(settings.businessName),
          emailSubject: emailTemplate?.subject ?? defaultWinbackEmailSubject(),
          emailBody: emailTemplate?.body ?? defaultWinbackEmailBody(settings.businessName),
        }}
        recentSends={sends.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          channel: campaign.channel,
          status: campaign.status,
          people: sentByCampaign.get(campaign.id) ?? 0,
          atLabel: formatInZone(campaign.createdAt, settings.timezone, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        }))}
      />
    </div>
  );
}

function historyLabel(message: {
  direction: string;
  kind: string;
  status: string;
  body: string;
}): string {
  if (message.direction === "inbound") {
    if (message.kind === "opt_stop") return "Replied STOP";
    if (message.kind === "opt_start") return "Opted back in";
    return "Their reply";
  }
  if (message.kind === "marketing") return "Outreach";
  return message.kind.replaceAll("_", " ");
}
