import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatInZone } from "@/lib/tz";
import { findSuppressed, normalizeDestination, type MarketingChannel } from "./suppressions";

/**
 * The win-back audience: customers whose appointment was cancelled or who did
 * not turn up. Built as a READ-ONLY view here — nothing is queued, consented or
 * sent from this module. The action layer does that, so this function can be
 * used to show the owner the list before anything is committed to.
 */

export type MissedOutcome = "cancelled" | "no_show";
/** What the owner picked in the builder. "missed" means either outcome. */
export type AudienceFilter = MissedOutcome | "missed";

/**
 * CASL footing for messaging this person, computed from what the shop actually
 * has on record rather than assumed.
 *
 * Canada's anti-spam law gives implied consent in two shapes that matter here
 * (s.10(9)): an EXISTING BUSINESS RELATIONSHIP — they bought something — which
 * runs two years from that purchase, and an INQUIRY, which runs only six months.
 * A booking somebody cancelled is an inquiry, not a purchase.
 *
 * `none` is the honest answer when both windows have closed, and those rows are
 * excluded from the list rather than quietly queued: the send would be refused
 * by the consent gate in sendMessage anyway (DECISIONS.md #8), and a row that
 * comes back "skipped" after the fact teaches the owner nothing.
 */
export type ConsentFooting = "express" | "existing_customer" | "inquiry" | "none";

/** Days each implied-consent basis stays open. */
export const FOOTING_WINDOW_DAYS = { existing_customer: 730, inquiry: 180 } as const;

export type AudienceCandidate = {
  appointmentId: string;
  customerId: string;
  firstName: string;
  companyName: string;
  /** Raw destination as stored, for display and for the queued snapshot. */
  destination: string;
  destinationNormalized: string;
  outcome: MissedOutcome;
  /** The reason as recorded, or null when nobody wrote one down. */
  reason: string | null;
  /** Business-local date of the appointment they missed. */
  missedOnLabel: string;
  missedAt: Date;
  services: string;
  totalCents: number;
  footing: ConsentFooting;
  /** Why this row cannot be messaged, or null when it can. */
  blockedReason: string | null;
  /** Already on this or another campaign — shown so it is not queued twice. */
  alreadyContacted: boolean;
};

export type AudienceSummary = {
  candidates: AudienceCandidate[];
  /** Counts for the header, including the rows that were filtered out. */
  totals: { eligible: number; blocked: number; scanned: number };
};

const OUTCOME_STATUS: Record<AudienceFilter, MissedOutcome[]> = {
  cancelled: ["cancelled"],
  no_show: ["no_show"],
  missed: ["cancelled", "no_show"],
};

/**
 * One row per missed appointment, newest first, already annotated with why it
 * can or cannot be messaged.
 *
 * Deliberately per-appointment rather than per-customer: the owner is choosing
 * who to win back by looking at what happened, and somebody who cancelled twice
 * is a different conversation from somebody who cancelled once. Queueing
 * collapses them — `outreach_recipients` is unique on the destination — so the
 * duplicate cannot turn into a second message.
 */
export async function findMissedAppointments(input: {
  filter: AudienceFilter;
  channel: MarketingChannel;
  /** How far back to look, in days. */
  withinDays: number;
  timezone: string;
  limit?: number;
}): Promise<AudienceSummary> {
  const statuses = OUTCOME_STATUS[input.filter];
  const since = new Date(Date.now() - input.withinDays * 24 * 60 * 60 * 1000);
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000);

  const rows = await db()
    .select({
      appointmentId: schema.appointments.id,
      customerId: schema.appointments.customerId,
      status: schema.appointments.status,
      startsAt: schema.appointments.startsAt,
      cancellationReason: schema.appointments.cancellationReason,
      noShowNote: schema.appointments.noShowNote,
      totalCents: schema.appointments.totalCents,
      firstName: schema.customers.firstName,
      companyName: schema.customers.companyName,
      email: schema.customers.email,
      phone: schema.customers.phone,
      marketingConsent: schema.customers.marketingConsent,
    })
    .from(schema.appointments)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.appointments.customerId))
    .where(
      and(
        inArray(schema.appointments.status, statuses),
        gte(schema.appointments.startsAt, since),
      ),
    )
    .orderBy(desc(schema.appointments.startsAt))
    .limit(limit);

  if (rows.length === 0) {
    return { candidates: [], totals: { eligible: 0, blocked: 0, scanned: 0 } };
  }

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const [purchasers, serviceLines, suppressed, contacted] = await Promise.all([
    recentPurchasers(customerIds),
    appointmentServiceLabels(rows.map((r) => r.appointmentId)),
    findSuppressed(
      db(),
      input.channel,
      rows.flatMap((r) => {
        const d = normalizeDestination(input.channel, input.channel === "sms" ? r.phone : r.email);
        return d ? [d] : [];
      }),
    ),
    alreadyOnACampaign(
      rows.flatMap((r) => {
        const d = normalizeDestination(input.channel, input.channel === "sms" ? r.phone : r.email);
        return d ? [d] : [];
      }),
    ),
  ]);

  const candidates: AudienceCandidate[] = [];
  let blocked = 0;

  for (const row of rows) {
    const rawDestination = (input.channel === "sms" ? row.phone : row.email) ?? "";
    const destinationNormalized = normalizeDestination(input.channel, rawDestination);
    const outcome = row.status as MissedOutcome;
    const reason =
      (outcome === "cancelled" ? row.cancellationReason : row.noShowNote)?.trim() || null;

    const footing = resolveFooting({
      expressConsent: row.marketingConsent,
      purchasedAt: purchasers.get(row.customerId) ?? null,
      inquiredAt: row.startsAt,
    });

    let blockedReason: string | null = null;
    if (!destinationNormalized) {
      blockedReason = input.channel === "sms" ? "No mobile number on file" : "No email address on file";
    } else if (suppressed.has(destinationNormalized)) {
      blockedReason = "On the do-not-contact list";
    } else if (footing === "none") {
      blockedReason = `Outside the CASL window — no purchase in ${FOOTING_WINDOW_DAYS.existing_customer / 365} years and the booking is over ${FOOTING_WINDOW_DAYS.inquiry / 30} months old`;
    }
    if (blockedReason) blocked += 1;

    candidates.push({
      appointmentId: row.appointmentId,
      customerId: row.customerId,
      firstName: row.firstName,
      companyName: row.companyName ?? "",
      destination: rawDestination,
      destinationNormalized: destinationNormalized ?? "",
      outcome,
      reason,
      missedAt: row.startsAt,
      missedOnLabel: formatInZone(row.startsAt, input.timezone, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      services: serviceLines.get(row.appointmentId) ?? "",
      totalCents: row.totalCents,
      footing,
      blockedReason,
      alreadyContacted: destinationNormalized ? contacted.has(destinationNormalized) : false,
    });
  }

  return {
    candidates,
    totals: { eligible: candidates.length - blocked, blocked, scanned: rows.length },
  };
}

/**
 * Which basis applies, strongest first. Express consent already recorded beats
 * both implied windows and does not expire on its own.
 */
export function resolveFooting(input: {
  expressConsent: boolean;
  purchasedAt: Date | null;
  inquiredAt: Date;
}): ConsentFooting {
  if (input.expressConsent) return "express";
  const now = Date.now();
  const days = (d: Date) => (now - d.getTime()) / (24 * 60 * 60 * 1000);
  if (input.purchasedAt && days(input.purchasedAt) <= FOOTING_WINDOW_DAYS.existing_customer) {
    return "existing_customer";
  }
  if (days(input.inquiredAt) <= FOOTING_WINDOW_DAYS.inquiry) return "inquiry";
  return "none";
}

export function describeFooting(footing: ConsentFooting): string {
  switch (footing) {
    case "express":
      return "Consent already recorded";
    case "existing_customer":
      return "Existing customer — bought within 2 years";
    case "inquiry":
      return "Booked with us within 6 months";
    default:
      return "No basis to message them";
  }
}

/**
 * Most recent PAID invoice per customer — the event CASL counts as a purchase.
 * An issued-but-unpaid invoice is not a purchase, and neither is a booking, so
 * neither is allowed to open the two-year window.
 */
async function recentPurchasers(customerIds: readonly string[]): Promise<Map<string, Date>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db()
    .select({
      customerId: schema.invoices.customerId,
      paidAt: sql<Date>`max(${schema.invoices.paidAt})`,
    })
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.customerId, [...customerIds]),
        eq(schema.invoices.status, "paid"),
      ),
    )
    .groupBy(schema.invoices.customerId);
  return new Map(
    rows.flatMap((r) => (r.customerId && r.paidAt ? [[r.customerId, new Date(r.paidAt)] as const] : [])),
  );
}

/** "Full Detail, Interior Shampoo" per appointment, for the list. */
async function appointmentServiceLabels(
  appointmentIds: readonly string[],
): Promise<Map<string, string>> {
  if (appointmentIds.length === 0) return new Map();
  const rows = await db()
    .select({
      appointmentId: schema.appointmentServices.appointmentId,
      name: schema.appointmentServices.description,
    })
    .from(schema.appointmentServices)
    .where(inArray(schema.appointmentServices.appointmentId, [...appointmentIds]))
    .orderBy(schema.appointmentServices.sort);
  const byAppointment = new Map<string, string[]>();
  for (const row of rows) {
    byAppointment.set(row.appointmentId, [...(byAppointment.get(row.appointmentId) ?? []), row.name]);
  }
  return new Map([...byAppointment].map(([id, names]) => [id, names.join(", ")]));
}

/**
 * Destinations any campaign has already SENT to. Surfaced in the builder so the
 * owner can see it before queueing; the send path enforces it again for real
 * (DECISIONS.md #20), because this snapshot goes stale the moment it is read.
 */
async function alreadyOnACampaign(destinations: readonly string[]): Promise<Set<string>> {
  const keys = [...new Set(destinations)];
  if (keys.length === 0) return new Set();
  const rows = await db()
    .select({ destination: schema.outreachRecipients.destinationNormalized })
    .from(schema.outreachRecipients)
    .where(
      and(
        eq(schema.outreachRecipients.status, "sent"),
        inArray(schema.outreachRecipients.destinationNormalized, keys),
      ),
    );
  return new Set(rows.map((r) => r.destination));
}

/* ------------------------------------------------------------------ */
/* Both channels at once, for the outreach workspace                   */
/* ------------------------------------------------------------------ */

/**
 * One missed appointment with BOTH channels annotated, because the composer
 * switches between text and email without leaving the page and each channel
 * has its own destination, its own do-not-contact list and its own answer to
 * "have we already messaged them".
 */
export type DualChannelCandidate = Omit<
  AudienceCandidate,
  "destination" | "destinationNormalized" | "blockedReason" | "alreadyContacted"
> & {
  sms: { destination: string; blockedReason: string | null; alreadyContacted: boolean };
  email: { destination: string; blockedReason: string | null; alreadyContacted: boolean };
};

export type DualChannelAudience = {
  rows: DualChannelCandidate[];
  totals: {
    scanned: number;
    sms: { eligible: number; blocked: number };
    email: { eligible: number; blocked: number };
  };
};

/**
 * The same list findMissedAppointments builds, resolved for text and email
 * together.
 *
 * Deliberately two calls rather than a channel-aware rewrite of the query: the
 * per-channel answer depends on four different lookups and the version above is
 * the one the CASL behaviour is tested against. They run in parallel, so the
 * screen waits for one round trip, not two, and this is an admin page a handful
 * of people open — the duplicated reads cost less than a second source of truth
 * for who may be messaged.
 */
export async function findMissedAudience(input: {
  filter: AudienceFilter;
  withinDays: number;
  timezone: string;
  limit?: number;
}): Promise<DualChannelAudience> {
  const [sms, email] = await Promise.all([
    findMissedAppointments({ ...input, channel: "sms" }),
    findMissedAppointments({ ...input, channel: "email" }),
  ]);

  const emailById = new Map(email.candidates.map((c) => [c.appointmentId, c]));
  const rows = sms.candidates.map((row) => {
    const other = emailById.get(row.appointmentId);
    return {
      appointmentId: row.appointmentId,
      customerId: row.customerId,
      firstName: row.firstName,
      companyName: row.companyName,
      outcome: row.outcome,
      reason: row.reason,
      missedAt: row.missedAt,
      missedOnLabel: row.missedOnLabel,
      services: row.services,
      totalCents: row.totalCents,
      footing: row.footing,
      sms: {
        destination: row.destination,
        blockedReason: row.blockedReason,
        alreadyContacted: row.alreadyContacted,
      },
      // `null` here means "nothing blocking them", so the missing-row fallback
      // has to be chosen by whether the row exists — not by `??`, which would
      // read a clear verdict as an absent one and block everybody.
      email: other
        ? {
            destination: other.destination,
            blockedReason: other.blockedReason,
            alreadyContacted: other.alreadyContacted,
          }
        : { destination: "", blockedReason: "No email address on file", alreadyContacted: false },
    };
  });

  return {
    rows,
    totals: {
      scanned: sms.totals.scanned,
      sms: { eligible: sms.totals.eligible, blocked: sms.totals.blocked },
      email: { eligible: email.totals.eligible, blocked: email.totals.blocked },
    },
  };
}
