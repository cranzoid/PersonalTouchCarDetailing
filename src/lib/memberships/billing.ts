import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { membershipSettings } from "./config";
import { sendMembershipEnded, sendMembershipPaymentFailed, sendPlanChangeNotice } from "./notify";
import { addMonthsClamped, cancelMembership, chargeMembershipPeriod, createSaleInvoice } from "./service";

/**
 * The monthly billing run, called from the hourly cron tick.
 *
 * Built to survive the scheduler being down. The cron did fail every run for
 * almost a month in 2026 (see the hourly-cron outage notes), so nothing here
 * assumes it ran an hour ago: a renewal is due whenever a paid month has
 * ended, however long ago, and the first tick back bills it once. The unique
 * (membership, period start) index makes the month itself impossible to
 * create twice, and chargeMembershipPeriod settles any earlier attempt with
 * Helcim before it sends another.
 */

export type BillingSummary = {
  renewed: number;
  declined: number;
  pending: number;
  retried: number;
  ended: number;
  notices: number;
  abandoned: number;
};

const ABANDONED_SIGNUP_MS = 2 * 60 * 60_000;
const LAST_RUN_KEY = "membershipBillingLastRunAt";

/** When billing last completed, for the "is billing running?" check in admin. */
export async function lastBillingRunAt(): Promise<Date | null> {
  const [row] = await db()
    .select()
    .from(schema.businessSettings)
    .where(eq(schema.businessSettings.key, LAST_RUN_KEY))
    .limit(1);
  const value = row?.value;
  return typeof value === "string" ? new Date(value) : null;
}

export async function runMembershipBilling(now = new Date()): Promise<BillingSummary> {
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const summary: BillingSummary = { renewed: 0, declined: 0, pending: 0, retried: 0, ended: 0, notices: 0, abandoned: 0 };

  // --- 1. Sign-ups started and never paid --------------------------------
  const stale = await db()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.status, "pending"), lt(schema.memberships.createdAt, new Date(now.getTime() - ABANDONED_SIGNUP_MS))));
  for (const { id } of stale) {
    const result = await cancelMembership({
      membershipId: id,
      actor: { type: "system" },
      reason: "Sign-up not completed",
      silent: true,
    }).catch(() => null);
    if (result?.ok) summary.abandoned++;
  }

  // --- 2. Months that have run out ---------------------------------------
  const due = await db()
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.status, "active"), isNotNull(schema.memberships.currentPeriodEnd), lte(schema.memberships.currentPeriodEnd, now)))
    .orderBy(asc(schema.memberships.currentPeriodEnd))
    .limit(200);
  for (const membership of due) {
    if (membership.cancelAtPeriodEnd) {
      await db().transaction(async (tx) => {
        const updated = await tx
          .update(schema.memberships)
          .set({ status: "canceled", canceledAt: now, updatedAt: now })
          .where(and(eq(schema.memberships.id, membership.id), eq(schema.memberships.status, "active")))
          .returning({ id: schema.memberships.id });
        if (updated.length > 0) {
          await audit(tx, {
            actorType: "system",
            action: "membership.ended",
            entityType: "membership",
            entityId: membership.id,
            after: { reason: membership.cancelReason ?? "Cancelled", endedAt: now.toISOString() },
          });
        }
      });
      summary.ended++;
      await sendMembershipEnded(membership.id, "canceled").catch((e) => console.error("ended notice failed", e));
      continue;
    }

    const periodId = await ensureNextPeriod(membership, settings, now);
    if (!periodId) continue;
    const outcome = await chargeMembershipPeriod(periodId);
    if (outcome === "approved") summary.renewed++;
    else if (outcome === "pending") summary.pending++;
    else if (outcome === "declined") {
      summary.declined++;
      await markPastDue(membership.id, periodId, config.retryDays, now);
    }
  }

  // --- 3. Retries for failed months --------------------------------------
  const retrying = await db()
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.status, "past_due"), isNotNull(schema.memberships.nextAttemptAt), lte(schema.memberships.nextAttemptAt, now)))
    .limit(200);
  for (const membership of retrying) {
    const [period] = await db()
      .select()
      .from(schema.membershipPeriods)
      .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.status, "failed")))
      .orderBy(sql`${schema.membershipPeriods.periodStart} desc`)
      .limit(1);
    if (!period) continue;
    summary.retried++;
    const outcome = await chargeMembershipPeriod(period.id);
    if (outcome === "declined" || outcome === "skipped") {
      await markPastDue(membership.id, period.id, config.retryDays, now);
    }
  }

  // --- 4. Plan changes coming up (the season turning over) ---------------
  const upcoming = await db()
    .select({ id: schema.memberships.id, nextPlanFrom: schema.memberships.nextPlanFrom })
    .from(schema.memberships)
    .where(
      and(
        inArray(schema.memberships.status, ["active", "past_due"]),
        isNotNull(schema.memberships.nextPlanId),
        isNull(schema.memberships.nextPlanNoticeSentAt),
      ),
    );
  for (const row of upcoming) {
    if (!row.nextPlanFrom) continue;
    const noticeAt = row.nextPlanFrom.getTime() - config.planChangeNoticeDays * 86_400_000;
    if (now.getTime() < noticeAt) continue;
    const sent = await sendPlanChangeNotice(row.id).catch(() => false);
    if (sent) {
      summary.notices++;
      await db()
        .update(schema.memberships)
        .set({ nextPlanNoticeSentAt: now, updatedAt: now })
        .where(eq(schema.memberships.id, row.id));
    }
  }

  await db()
    .insert(schema.businessSettings)
    .values({ key: LAST_RUN_KEY, value: now.toISOString() })
    .onConflictDoUpdate({ target: schema.businessSettings.key, set: { value: now.toISOString(), updatedAt: now } });
  return summary;
}

/**
 * Creates (once) the month that follows the paid one, with its invoice. If a
 * plan change is scheduled to have started by then, the new month is billed on
 * the new plan — paying it is what moves the member across.
 */
async function ensureNextPeriod(
  membership: typeof schema.memberships.$inferSelect,
  settings: Awaited<ReturnType<typeof getSettings>>,
  now: Date,
): Promise<string | null> {
  const start = membership.currentPeriodEnd!;
  const [existing] = await db()
    .select()
    .from(schema.membershipPeriods)
    .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.periodStart, start)))
    .limit(1);
  if (existing) return existing.status === "paid" || existing.status === "waived" ? null : existing.id;

  const switching = Boolean(membership.nextPlanId && membership.nextPlanFrom && membership.nextPlanFrom <= start);
  const planId = switching ? membership.nextPlanId! : membership.planId;
  const [plan] = await db().select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, planId)).limit(1);
  if (!plan) return null;
  const amountCents = switching ? plan.monthlyPriceCents : membership.priceCents;
  const end = addMonthsClamped(start, 1);
  const fmt = (d: Date) => formatInZone(d, settings.timezone, { month: "short", day: "numeric", year: "numeric" });

  return db().transaction(async (tx) => {
    const periodId = newId("mpd");
    const inserted = await tx
      .insert(schema.membershipPeriods)
      .values({ id: periodId, membershipId: membership.id, planId, periodStart: start, periodEnd: end, amountCents })
      .onConflictDoNothing()
      .returning({ id: schema.membershipPeriods.id });
    if (inserted.length === 0) {
      // A racing tick created it first; charge that one.
      const [row] = await tx
        .select({ id: schema.membershipPeriods.id })
        .from(schema.membershipPeriods)
        .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.periodStart, start)));
      return row?.id ?? null;
    }
    const invoice = await createSaleInvoice(tx, {
      customerId: membership.customerId,
      vehicleId: membership.vehicleId,
      lines: [{ description: `${plan.name} — ${fmt(start)} – ${fmt(new Date(end.getTime() - 1))}`, unitPriceCents: amountCents }],
      notes: "Monthly membership. Renews automatically each month until cancelled.",
      settings,
    });
    await tx
      .update(schema.membershipPeriods)
      .set({ invoiceId: invoice.id })
      .where(eq(schema.membershipPeriods.id, periodId));
    await audit(tx, {
      actorType: "system",
      action: "membership.period_billed",
      entityType: "membership",
      entityId: membership.id,
      after: { periodId, invoiceId: invoice.id, planId, amountCents, periodStart: start.toISOString(), billedAt: now.toISOString() },
    });
    return periodId;
  });
}

/**
 * After a decline: benefits pause and the next try is scheduled from the
 * month's due date. Past the last scheduled retry the membership ends.
 */
async function markPastDue(membershipId: string, periodId: string, retryDays: number[], now: Date): Promise<void> {
  const [membership] = await db().select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).limit(1);
  const [period] = await db().select().from(schema.membershipPeriods).where(eq(schema.membershipPeriods.id, periodId)).limit(1);
  if (!membership || !period || membership.status === "canceled") return;
  const attempts = membership.status === "past_due" ? membership.failedAttempts + 1 : 1;
  const retryDay = retryDays[attempts - 1];
  if (retryDay === undefined) {
    // Out of retries. Past due first, so cancelMembership ends it at once and
    // cancels the uncollected invoice rather than waiting out a month nobody
    // paid for; then tell the member why.
    await db()
      .update(schema.memberships)
      .set({ status: "past_due", updatedAt: now })
      .where(eq(schema.memberships.id, membershipId));
    await cancelMembership({
      membershipId,
      actor: { type: "system" },
      reason: "Monthly payment could not be collected",
      silent: true,
    });
    await sendMembershipEnded(membershipId, "payment_failed").catch(() => undefined);
    return;
  }
  const nextAttemptAt = new Date(period.periodStart.getTime() + retryDay * 86_400_000);
  await db()
    .update(schema.memberships)
    .set({
      status: "past_due",
      failedAttempts: attempts,
      nextAttemptAt: nextAttemptAt > now ? nextAttemptAt : new Date(now.getTime() + 86_400_000),
      pastDueSince: membership.pastDueSince ?? now,
      updatedAt: now,
    })
    .where(eq(schema.memberships.id, membershipId));
  await sendMembershipPaymentFailed(membershipId, { nextAttemptAt }).catch((e) => console.error("failed-payment notice failed", e));
}
