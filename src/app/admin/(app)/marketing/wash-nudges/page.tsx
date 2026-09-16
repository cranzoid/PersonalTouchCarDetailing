import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { withinSendWindow } from "@/lib/marketing/message";
import { findSuppressed, normalizeDestination } from "@/lib/marketing/suppressions";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { getAppBaseUrl } from "@/lib/urls";
import { activeWashOffer, formatClaimCode } from "@/lib/wash-offer";
import {
  daysLeftLabel,
  DEFAULT_NUDGE_EMAIL_BODY,
  DEFAULT_NUDGE_EMAIL_SUBJECT,
  DEFAULT_NUDGE_SMS,
  NUDGE_TEMPLATE_KEYS,
} from "@/lib/wash-offer-nudge-message";
import {
  nudgeBlockReason,
  nudgeProviderReady,
  nudgeValuesFor,
  sampleNudgeValues,
} from "@/lib/wash-offer-nudges";
import { subtle } from "../ui";
import { NudgeWorkspace, type NudgeHistoryItem, type NudgeRow } from "./nudge-workspace";

export const dynamic = "force-dynamic";

/**
 * Outreach → First-wash nudges.
 *
 * A live list of everyone who claimed the new-customer wash, with what has
 * been sent to each of them, and a composer for texting or emailing the ones
 * who have not booked. See src/lib/wash-offer-nudges.ts for why this is its
 * own screen rather than a marketing campaign.
 */
export default async function WashNudgesPage() {
  await requirePageStaff("manage_marketing");
  const settings = await getSettings();
  const offer = activeWashOffer(settings);
  const nowMs = Date.now();
  let baseUrl = "";
  try {
    baseUrl = getAppBaseUrl();
  } catch {
    baseUrl = "";
  }

  const claimRows = await db()
    .select({
      claim: schema.offerClaims,
      leadConsent: schema.leads.marketingConsent,
      leadAnonymizedAt: schema.leads.anonymizedAt,
      appointmentStartsAt: schema.appointments.startsAt,
    })
    .from(schema.offerClaims)
    .leftJoin(schema.leads, eq(schema.leads.id, schema.offerClaims.leadId))
    .leftJoin(schema.appointments, eq(schema.appointments.id, schema.offerClaims.appointmentId))
    .orderBy(desc(schema.offerClaims.createdAt))
    .limit(500);

  const phones = claimRows
    .map((row) => normalizeDestination("sms", row.claim.phone))
    .filter((v): v is string => Boolean(v));
  const emails = claimRows
    .map((row) => normalizeDestination("email", row.claim.email))
    .filter((v): v is string => Boolean(v));
  const [smsSuppressed, emailSuppressed] = await Promise.all([
    findSuppressed(db(), "sms", phones),
    findSuppressed(db(), "email", emails),
  ]);

  // Everything sent to or received from these people — the codes, the
  // automatic reminders, the nudges, their replies — so staff can see the
  // whole conversation before adding to it.
  const leadIds = [...new Set(claimRows.map((row) => row.claim.leadId).filter((v): v is string => Boolean(v)))];
  const messages = leadIds.length
    ? await db()
        .select({
          id: schema.communications.id,
          leadId: schema.communications.leadId,
          direction: schema.communications.direction,
          channel: schema.communications.channel,
          kind: schema.communications.kind,
          subject: schema.communications.subject,
          body: schema.communications.body,
          status: schema.communications.status,
          relatedEntityType: schema.communications.relatedEntityType,
          createdAt: schema.communications.createdAt,
          staffName: schema.staffUsers.name,
        })
        .from(schema.communications)
        .leftJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.communications.createdByStaffId))
        .where(inArray(schema.communications.leadId, leadIds))
        .orderBy(desc(schema.communications.createdAt))
    : [];
  const historyByLead = new Map<string, NudgeHistoryItem[]>();
  for (const message of messages) {
    if (!message.leadId) continue;
    const list = historyByLead.get(message.leadId) ?? [];
    if (list.length >= 30) continue;
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
    historyByLead.set(message.leadId, list);
  }

  const [templates, smsReady, emailReady] = await Promise.all([
    db()
      .select()
      .from(schema.messageTemplates)
      .where(inArray(schema.messageTemplates.key, [NUDGE_TEMPLATE_KEYS.sms, NUDGE_TEMPLATE_KEYS.email])),
    nudgeProviderReady("sms"),
    nudgeProviderReady("email"),
  ]);
  const smsTemplate = templates.find((t) => t.key === NUDGE_TEMPLATE_KEYS.sms);
  const emailTemplate = templates.find((t) => t.key === NUDGE_TEMPLATE_KEYS.email);

  const date = (value: Date) =>
    formatInZone(value, settings.timezone, { month: "short", day: "numeric" });

  const rows: NudgeRow[] = claimRows.map(({ claim, leadConsent, leadAnonymizedAt, appointmentStartsAt }) => {
    const expired = claim.status === "expired" || (claim.status === "issued" && claim.expiresAt.getTime() <= nowMs);
    const state: NudgeRow["state"] =
      claim.status === "issued" && !expired
        ? "open"
        : claim.status === "booked"
          ? "booked"
          : claim.status === "redeemed"
            ? "washed"
            : claim.status === "void"
              ? "released"
              : "expired";
    const block = (channel: "sms" | "email") =>
      offer
        ? nudgeBlockReason({
            claim,
            channel,
            offerCode: offer.code,
            leadConsent,
            leadAnonymizedAt,
            suppressed:
              channel === "sms"
                ? smsSuppressed.has(normalizeDestination("sms", claim.phone) ?? "")
                : emailSuppressed.has(normalizeDestination("email", claim.email) ?? ""),
            nowMs,
          })
        : "Offer is switched off";
    const lastNudge = [claim.lastSmsNudgeAt, claim.lastEmailNudgeAt]
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const history = claim.leadId ? (historyByLead.get(claim.leadId) ?? []) : [];

    return {
      id: claim.id,
      leadId: claim.leadId,
      appointmentId: claim.appointmentId,
      name: [claim.firstName, claim.lastName].filter(Boolean).join(" ").trim() || "—",
      phone: claim.phone ? formatPhone(claim.phone) : null,
      email: claim.email,
      code: formatClaimCode(claim.code),
      state,
      claimedLabel: date(claim.createdAt),
      expiresLabel: date(claim.expiresAt),
      daysLeft: state === "open" ? daysLeftLabel(claim.expiresAt, nowMs) : null,
      appointmentLabel: appointmentStartsAt
        ? formatInZone(appointmentStartsAt, settings.timezone, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : null,
      smsNudges: claim.smsNudgesSent,
      emailNudges: claim.emailNudgesSent,
      lastNudgeLabel: lastNudge ? date(lastNudge) : null,
      blockedSms: block("sms"),
      blockedEmail: block("email"),
      values: offer && baseUrl ? nudgeValuesFor({ claim, offer, settings, baseUrl, nowMs }) : null,
      history,
    };
  });

  const open = rows.filter((r) => r.state === "open");
  const stats = {
    open: open.length,
    neverNudged: open.filter((r) => r.smsNudges + r.emailNudges === 0).length,
    textsSent: rows.reduce((n, r) => n + r.smsNudges, 0),
    emailsSent: rows.reduce((n, r) => n + r.emailNudges, 0),
    booked: rows.filter((r) => r.state === "booked").length,
    washed: rows.filter((r) => r.state === "washed").length,
  };

  return (
    <div className="max-w-[92rem]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/marketing" className="text-xs font-semibold text-[#8A681F] hover:underline">
            ← Outreach
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">First-wash nudges</h1>
          <p className={`mt-1 max-w-3xl ${subtle}`}>
            Everyone who claimed the new-customer wash. Pick the people who have not booked yet, check
            the message, and send them a nudge by text or email. Each person can be nudged once a day
            per channel, and anyone who replied STOP or unsubscribed is skipped automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/marketing/offer-claims/redeem"
            className="inline-flex min-h-10 items-center rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
          >
            Redeem a code
          </Link>
          <Link
            href="/admin/marketing/offer-claims"
            className="inline-flex min-h-10 items-center rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A]"
          >
            All offer claims
          </Link>
        </div>
      </header>

      {!offer && (
        <p className="mt-4 rounded-xl border border-[#E3D8BF] bg-[#FBF6EC] p-4 text-sm text-[#8A681F]">
          The wash offer is switched off, so nudges cannot be sent — the booking link in them would not
          accept the code. The history below is still accurate.
        </p>
      )}

      <NudgeWorkspace
        rows={rows}
        stats={stats}
        offerActive={Boolean(offer && baseUrl)}
        businessName={settings.businessName}
        sendWindow={withinSendWindow(new Date(), settings.timezone)}
        providerReady={{ sms: smsReady, email: emailReady }}
        sample={offer && baseUrl ? sampleNudgeValues({ offer, settings, baseUrl, nowMs }) : null}
        templates={{
          sms: smsTemplate?.body ?? DEFAULT_NUDGE_SMS,
          emailSubject: emailTemplate?.subject ?? DEFAULT_NUDGE_EMAIL_SUBJECT,
          emailBody: emailTemplate?.body ?? DEFAULT_NUDGE_EMAIL_BODY,
        }}
      />
    </div>
  );
}

function historyLabel(message: {
  direction: string;
  kind: string;
  relatedEntityType: string | null;
  status: string;
  body: string;
}): string {
  if (message.direction === "inbound") {
    if (message.kind === "opt_stop") return "Replied STOP";
    if (message.kind === "opt_start") return "Opted back in";
    return "Their reply";
  }
  if (message.relatedEntityType === "offer_claim") {
    if (message.kind === "marketing") return message.body.startsWith("[SUPPRESSED") ? "Nudge (blocked)" : "Nudge";
    return "Code / automatic reminder";
  }
  return message.kind.replaceAll("_", " ");
}
