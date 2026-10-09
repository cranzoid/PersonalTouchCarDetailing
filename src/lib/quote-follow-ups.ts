import "server-only";

import { and, asc, count, eq, inArray, isNotNull, lte, ne, type SQL } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { localDateISO, zonedToUtc } from "@/lib/tz";
import {
  DEFAULT_FOLLOW_UP_EMAIL_BODY,
  DEFAULT_FOLLOW_UP_EMAIL_SUBJECT,
  DEFAULT_FOLLOW_UP_SMS,
  FOLLOW_UP_TEMPLATE_KEYS,
  type FollowUpChannel,
  type FollowUpMethod,
  type FollowUpValues,
} from "@/lib/quote-follow-up-message";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Following up on quote and callback requests.
 *
 * A callback request is a quote request: the ceramic-protection enquiry form
 * goes through the same public action and lands in the same table, marked only
 * by `attribution.enquiryType`. So everything here applies to both.
 *
 * Two things are tracked on the request itself — when it was last chased and
 * when it is next due — and the detail lives in quote_request_activities: every
 * follow-up (sent from here, or a call logged after the fact) and every staff
 * comment. A follow-up is never inferred from the communications table, because
 * that also holds the automatic acknowledgement the form sent, which is nobody
 * following anything up.
 */

/** Transaction handle, as handed to the callback by `db().transaction`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Start of the business-local calendar day `date` falls on. */
export function startOfLocalDay(timeZone: string, date: Date): Date {
  return localDayToUtc(timeZone, localDateISO(timeZone, 0, date.getTime()));
}

/** "2026-10-14" → the instant that day starts in the business's time zone. */
export function localDayToUtc(timeZone: string, isoDay: string): Date {
  const [y, m, d] = isoDay.split("-").map(Number);
  return zonedToUtc(timeZone, y, m, d, 0, 0);
}

/**
 * How long a quote request lets us keep messaging someone who never agreed to
 * marketing. CASL treats an inquiry about a product as implied consent for six
 * months from the inquiry; after that we need their express consent, or a call.
 */
export function impliedConsentEnds(requestedAt: Date): Date {
  const end = new Date(requestedAt);
  end.setUTCMonth(end.getUTCMonth() + 6);
  return end;
}

/**
 * Why this request cannot be followed up on this channel right now, or null.
 * Pure, so the page can explain it before anyone writes a message and the
 * action can refuse with the same words.
 */
export function followUpBlock(input: {
  channel: FollowUpChannel;
  lead: {
    email: string | null;
    phone: string | null;
    marketingConsent: boolean;
    anonymizedAt: Date | null;
  };
  requestedAt: Date;
  now: Date;
  /** The destination is on the do-not-contact list (STOP, unsubscribe, manual). */
  suppressed: boolean;
}): string | null {
  if (input.lead.anonymizedAt) return "This contact's details were erased at their request.";
  if (input.channel === "sms" && !input.lead.phone) return "There is no phone number on this request.";
  if (input.channel === "email" && !input.lead.email) return "There is no email address on this request.";
  if (input.suppressed) {
    return input.channel === "sms"
      ? "This number replied STOP, so it cannot be texted. Call them instead."
      : "This address unsubscribed from our emails. Call or text them instead.";
  }
  if (!input.lead.marketingConsent && input.now >= impliedConsentEnds(input.requestedAt)) {
    return "This request is over six months old and they never agreed to marketing messages, so CASL no longer lets us message them about it. Call them instead.";
  }
  return null;
}

/** Due means the scheduled day has started, on a request nobody has closed. */
export function isFollowUpDue(
  request: { status: string; nextFollowUpAt: Date | null },
  now: Date,
): boolean {
  return request.status !== "closed" && request.nextFollowUpAt !== null && request.nextFollowUpAt <= now;
}

/** A ceramic-protection callback request, rather than a general quote request. */
export function isCallbackRequest(attribution: unknown): boolean {
  return (
    typeof attribution === "object" &&
    attribution !== null &&
    (attribution as Record<string, unknown>).enquiryType === "ceramic_callback"
  );
}

export function vehicleLabel(info: { year?: number; make?: string; model?: string } | null): string {
  return [info?.year, info?.make, info?.model].filter(Boolean).join(" ");
}

/** The values one request's follow-up is written from. */
export function followUpValuesFor(input: {
  leadName: string;
  vehicleInfo: { year?: number; make?: string; model?: string } | null;
  serviceNames: readonly string[];
  requestedAt: Date;
  settings: Pick<BusinessSettings, "businessName" | "phone" | "timezone">;
  baseUrl: string;
  /** Callback requests carry no service ids; the form names the product. */
  callback?: boolean;
}): FollowUpValues {
  const services =
    input.serviceNames.length > 0
      ? joinWithAnd(input.serviceNames)
      : input.callback
        ? "ceramic protection"
        : "detailing";
  return {
    firstName: input.leadName.trim().split(/\s+/)[0] || "there",
    vehicle: vehicleLabel(input.vehicleInfo) || "vehicle",
    services,
    requestedOn: new Intl.DateTimeFormat("en-CA", {
      timeZone: input.settings.timezone,
      month: "short",
      day: "numeric",
    }).format(input.requestedAt),
    bookingLink: `${input.baseUrl}/book`,
    phone: input.settings.phone,
    businessName: input.settings.businessName,
  };
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Stamps a follow-up onto a request, inside the caller's transaction.
 *
 * Shared by "send" and "log" so the two can never disagree on what a follow-up
 * changes: the activity row, the last/next dates on the request, and the lead
 * moving from "new" to "contacted" — which is what that status has always meant.
 */
export async function recordFollowUp(
  tx: Tx,
  input: {
    quoteRequestId: string;
    leadId: string | null;
    method: FollowUpMethod;
    note: string | null;
    communicationId: string | null;
    staffId: string;
    nextFollowUpAt: Date | null;
    now: Date;
  },
): Promise<string> {
  const activityId = newId("qra");
  await tx.insert(schema.quoteRequestActivities).values({
    id: activityId,
    quoteRequestId: input.quoteRequestId,
    kind: "follow_up",
    method: input.method,
    body: input.note,
    communicationId: input.communicationId,
    staffId: input.staffId,
    createdAt: input.now,
  });
  await tx
    .update(schema.quoteRequests)
    .set({ lastFollowedUpAt: input.now, nextFollowUpAt: input.nextFollowUpAt, updatedAt: input.now })
    .where(eq(schema.quoteRequests.id, input.quoteRequestId));
  await audit(tx, {
    actorType: "staff",
    actorId: input.staffId,
    action: "quote_request.followed_up",
    entityType: "quote_request",
    entityId: input.quoteRequestId,
    after: {
      method: input.method,
      communicationId: input.communicationId,
      nextFollowUpAt: input.nextFollowUpAt?.toISOString() ?? null,
    },
  });

  if (input.leadId) {
    const moved = await tx
      .update(schema.leads)
      .set({ status: "contacted", updatedAt: input.now })
      .where(and(eq(schema.leads.id, input.leadId), eq(schema.leads.status, "new")))
      .returning({ id: schema.leads.id });
    if (moved.length > 0) {
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: "lead.status_changed",
        entityType: "lead",
        entityId: input.leadId,
        before: { status: "new" },
        after: { status: "contacted" },
        reason: "Followed up on their quote request",
      });
    }
  }
  return activityId;
}

/** isFollowUpDue, as a query condition. */
export function followUpDueWhere(now: Date): SQL {
  return and(
    isNotNull(schema.quoteRequests.nextFollowUpAt),
    lte(schema.quoteRequests.nextFollowUpAt, now),
    ne(schema.quoteRequests.status, "closed"),
  )!;
}

export type DueFollowUp = {
  id: string;
  name: string;
  callback: boolean;
  vehicle: string;
  nextFollowUpAt: Date;
  lastFollowedUpAt: Date | null;
};

/** Requests whose follow-up day has come, oldest-due first. */
export async function loadDueFollowUps(
  now: Date,
  limit = 8,
): Promise<{ total: number; items: DueFollowUp[] }> {
  const due = followUpDueWhere(now);
  const [{ n }] = await db().select({ n: count() }).from(schema.quoteRequests).where(due);
  const rows = await db()
    .select({
      id: schema.quoteRequests.id,
      vehicleInfo: schema.quoteRequests.vehicleInfo,
      nextFollowUpAt: schema.quoteRequests.nextFollowUpAt,
      lastFollowedUpAt: schema.quoteRequests.lastFollowedUpAt,
      name: schema.leads.name,
      attribution: schema.leads.attribution,
    })
    .from(schema.quoteRequests)
    .leftJoin(schema.leads, eq(schema.leads.id, schema.quoteRequests.leadId))
    .where(due)
    .orderBy(asc(schema.quoteRequests.nextFollowUpAt))
    .limit(limit);
  return {
    total: n,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name ?? "Unknown",
      callback: isCallbackRequest(row.attribution),
      vehicle: vehicleLabel(row.vehicleInfo),
      nextFollowUpAt: row.nextFollowUpAt!,
      lastFollowedUpAt: row.lastFollowedUpAt,
    })),
  };
}

/**
 * The dashboard's copy: a failure here (say, a migration that has not landed)
 * hides one card instead of breaking the whole dashboard.
 */
export async function dueFollowUpsOrNone(
  now: Date,
  limit?: number,
): Promise<{ total: number; items: DueFollowUp[] } | null> {
  try {
    return await loadDueFollowUps(now, limit);
  } catch (error) {
    console.error("[quote-follow-ups] due follow-ups unavailable", error instanceof Error ? error.message : "");
    return null;
  }
}

/** How many follow-ups each request has had, for the list. */
export async function followUpCounts(quoteRequestIds: readonly string[]): Promise<Map<string, number>> {
  if (quoteRequestIds.length === 0) return new Map();
  const rows = await db()
    .select({ id: schema.quoteRequestActivities.quoteRequestId, n: count() })
    .from(schema.quoteRequestActivities)
    .where(
      and(
        inArray(schema.quoteRequestActivities.quoteRequestId, [...quoteRequestIds]),
        eq(schema.quoteRequestActivities.kind, "follow_up"),
      ),
    )
    .groupBy(schema.quoteRequestActivities.quoteRequestId);
  return new Map(rows.map((row) => [row.id, row.n]));
}

/**
 * The wording the composer opens with: the saved templates, or the built-in
 * defaults if a template row is missing (the seed adds them at boot, but a
 * screen should not depend on that having happened).
 */
export async function loadFollowUpWording(): Promise<{
  sms: string;
  emailSubject: string;
  emailBody: string;
}> {
  const rows = await db()
    .select()
    .from(schema.messageTemplates)
    .where(inArray(schema.messageTemplates.key, Object.values(FOLLOW_UP_TEMPLATE_KEYS)));
  const sms = rows.find((row) => row.key === FOLLOW_UP_TEMPLATE_KEYS.sms);
  const email = rows.find((row) => row.key === FOLLOW_UP_TEMPLATE_KEYS.email);
  return {
    sms: sms?.body ?? DEFAULT_FOLLOW_UP_SMS,
    emailSubject: email?.subject ?? DEFAULT_FOLLOW_UP_EMAIL_SUBJECT,
    emailBody: email?.body ?? DEFAULT_FOLLOW_UP_EMAIL_BODY,
  };
}

/**
 * One request with everything a follow-up is written and checked from. Loaded
 * the same way by the page that previews a message and the action that sends
 * it, so the preview and the sent text are filled in from the same values.
 */
export async function loadQuoteForFollowUp(quoteRequestId: string) {
  const [quote] = await db()
    .select()
    .from(schema.quoteRequests)
    .where(eq(schema.quoteRequests.id, quoteRequestId))
    .limit(1);
  if (!quote) return null;
  const [lead] = quote.leadId
    ? await db().select().from(schema.leads).where(eq(schema.leads.id, quote.leadId)).limit(1)
    : [];
  const services =
    quote.requestedServiceIds.length > 0
      ? await db()
          .select({ id: schema.services.id, name: schema.services.name })
          .from(schema.services)
          .where(inArray(schema.services.id, quote.requestedServiceIds))
      : [];
  const settings = await getSettings();
  const callback = isCallbackRequest(lead?.attribution);
  const values = followUpValuesFor({
    leadName: lead?.name ?? "",
    vehicleInfo: quote.vehicleInfo,
    serviceNames: services.map((service) => service.name),
    requestedAt: quote.createdAt,
    settings,
    baseUrl: getAppBaseUrl(),
    callback,
  });
  return { quote, lead: lead ?? null, services, settings, values, callback };
}
