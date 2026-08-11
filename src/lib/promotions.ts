import { and, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { percentCents } from "@/lib/money";
import { localDateISO } from "@/lib/tz";
import type { BusinessSettings } from "@/lib/settings";

/**
 * Ad-driven promotion ("10% off your first detail").
 *
 * Everything here except the eligibility query is pure, so the money rules are
 * unit-testable without a database. The browser only ever supplies a *claimed
 * code*; the percentage, the label, the eligible services and the resulting
 * cents are always resolved server-side from settings.
 */

export type ResolvedPromotion = {
  code: string;
  label: string;
  percentOffBp: number;
  firstTimeOnly: boolean;
  eligibleServiceIds: string[];
};

/** A priced line, narrowed to what the discount rules actually need. */
type DiscountableLine = { serviceId?: string; priceCents: number };

/**
 * The promotion currently on offer, ignoring whether anyone has claimed it.
 *
 * Fails closed on every axis: disabled, zero percent, no eligible services, or
 * expired. An empty eligible list deliberately means "nothing", never
 * "everything".
 *
 * The booking page needs this shape before it knows whether the visitor holds
 * a claim, because the claim may be sitting in localStorage from an earlier
 * landing page rather than in the URL. The code it returns is not a secret —
 * it is in the public ad URL — so eligibility, not obscurity, is what protects
 * the offer.
 */
export function activePromotion(
  settings: Pick<BusinessSettings, "promotion" | "timezone">,
  nowMs: number = Date.now(),
): ResolvedPromotion | null {
  const promo = settings.promotion;
  if (!promo?.enabled) return null;
  if (promo.percentOffBp <= 0) return null;
  if (promo.eligibleServiceIds.length === 0) return null;

  // Calendar comparison in the business timezone: "runs through Friday" is a
  // date statement, and both sides are YYYY-MM-DD so string order is date order.
  if (promo.expiresOn && localDateISO(settings.timezone, 0, nowMs) > promo.expiresOn) return null;

  return {
    code: promo.code.trim().toUpperCase(),
    label: promo.label,
    percentOffBp: promo.percentOffBp,
    firstTimeOnly: promo.firstTimeOnly,
    eligibleServiceIds: [...promo.eligibleServiceIds],
  };
}

/** The active promotion, but only if this claimed code matches it. */
export function resolveActivePromotion(
  settings: Pick<BusinessSettings, "promotion" | "timezone">,
  claimedCode: string | undefined | null,
  nowMs: number = Date.now(),
): ResolvedPromotion | null {
  const promo = activePromotion(settings, nowMs);
  if (!promo) return null;
  const claim = claimedCode?.trim().toUpperCase();
  return claim && claim === promo.code ? promo : null;
}

/**
 * The portion of the subtotal the offer applies to.
 *
 * Only service lines count. Add-ons are excluded: "10% off your first detail"
 * is the package, not the extras chosen alongside it.
 */
export function eligibleBaseCents(
  lines: readonly DiscountableLine[],
  eligibleServiceIds: readonly string[],
): number {
  const eligible = new Set(eligibleServiceIds);
  return lines.reduce(
    (sum, line) => (line.serviceId && eligible.has(line.serviceId) ? sum + line.priceCents : sum),
    0,
  );
}

/** Discount for an eligible base, clamped to it. Mirrors computeInvoiceTotals. */
export function promotionDiscountCents(eligibleBase: number, percentOffBp: number): number {
  if (eligibleBase <= 0 || percentOffBp <= 0) return 0;
  return Math.min(Math.max(0, percentCents(eligibleBase, percentOffBp)), eligibleBase);
}

/**
 * Splits a locked discount across the eligible lines so the parts sum to it
 * exactly (largest-remainder apportionment).
 *
 * This exists so a percentage *deposit* can be charged on the discounted line
 * price without the deposit basis and the appointment total disagreeing by a
 * cent. The discount itself is always the single figure `discountCents` — this
 * only decides how it is attributed for deposit purposes.
 *
 * Ties go to the earlier line, so the split is deterministic for a given cart.
 */
export function allocateDiscount(
  lines: readonly DiscountableLine[],
  eligibleServiceIds: readonly string[],
  discountCents: number,
): number[] {
  const alloc = new Array(lines.length).fill(0);
  if (discountCents <= 0) return alloc;

  const eligible = new Set(eligibleServiceIds);
  const idx = lines
    .map((line, i) => ({ i, price: line.priceCents }))
    .filter(({ i, price }) => price > 0 && lines[i].serviceId && eligible.has(lines[i].serviceId!));
  const base = idx.reduce((sum, { price }) => sum + price, 0);
  if (base <= 0) return alloc;

  const capped = Math.min(discountCents, base);
  const remainders: { i: number; rem: number }[] = [];
  let assigned = 0;
  for (const { i, price } of idx) {
    const exact = (capped * price) / base;
    const floor = Math.floor(exact);
    alloc[i] = floor;
    assigned += floor;
    remainders.push({ i, rem: exact - floor });
  }

  // Hand out the rounding remainder, largest fractional part first.
  remainders.sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let n = capped - assigned, k = 0; n > 0 && k < remainders.length; n--, k++) {
    alloc[remainders[k].i] += 1;
  }
  return alloc;
}

/**
 * True when this contact has never had a detail fulfilled with us and does not
 * already hold an unfulfilled discounted booking.
 *
 * Identity is the contact details, never customers.id: a public booking always
 * inserts a fresh customers row, so the same person is a new row every time.
 * Email is compared case-insensitively and phone by digits only, because the
 * same person types "905-679-0143" once and "(905) 679 0143" the next.
 */
export async function isFirstTimeDetailCustomer(
  runner: Pick<Db, "select">,
  contact: { email?: string | null; phone?: string | null },
  eligibleServiceIds: readonly string[],
): Promise<boolean> {
  const email = contact.email?.trim().toLowerCase() || undefined;
  const phone = contact.phone?.replace(/\D/g, "") || undefined;
  // No way to identify them — treat as first-time; the booking itself requires
  // one of the two, so this only guards odd staff-side callers.
  if (!email && !phone) return true;

  const contactMatch = or(
    email ? sql`lower(${schema.customers.email}) = ${email}` : undefined,
    phone ? sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '\\D', '', 'g') = ${phone}` : undefined,
  );

  // (a) A previous appointment for an eligible service that actually happened.
  // Jobs are the operational truth, but completedAt is checked too: job rows
  // predating the three-stage pipeline hold retired statuses and would
  // otherwise read as unfinished.
  if (eligibleServiceIds.length > 0) {
    const fulfilled = await runner
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .innerJoin(schema.customers, eq(schema.appointments.customerId, schema.customers.id))
      .innerJoin(
        schema.appointmentServices,
        eq(schema.appointmentServices.appointmentId, schema.appointments.id),
      )
      .leftJoin(schema.jobs, eq(schema.jobs.appointmentId, schema.appointments.id))
      .where(
        and(
          isNull(schema.customers.anonymizedAt),
          contactMatch,
          inArray(schema.appointmentServices.serviceId, [...eligibleServiceIds]),
          or(
            inArray(schema.jobs.status, ["ready_for_pickup", "completed"]),
            sql`${schema.jobs.completedAt} is not null`,
            eq(schema.appointments.status, "completed"),
          ),
        ),
      )
      .limit(1);
    if (fulfilled.length > 0) return false;
  }

  // (b) They already hold a discounted booking that has not been fulfilled.
  // Without this a first-time customer could take the offer three times in one
  // sitting, since none of those bookings has happened yet.
  const outstanding = await runner
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .innerJoin(schema.customers, eq(schema.appointments.customerId, schema.customers.id))
    .where(
      and(
        isNull(schema.customers.anonymizedAt),
        contactMatch,
        gt(schema.appointments.discountCents, 0),
        notInArray(schema.appointments.status, ["cancelled", "no_show"]),
      ),
    )
    .limit(1);
  return outstanding.length === 0;
}
