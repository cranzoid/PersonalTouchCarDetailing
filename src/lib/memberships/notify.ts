import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents, taxCents } from "@/lib/money";
import { sendMessage } from "@/lib/messaging";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Service messages for memberships and Winter Passes. Plain operational mail,
 * outside the marketing consent gate — a member is owed notice of a charge, a
 * failed card or a plan change whether or not they opted into promotions.
 *
 * Deliberately says nothing about a minimum commitment either way: the owners
 * asked for that not to be written down.
 */

type Recipient = { id: string; firstName: string; email: string | null; phone: string | null; preferredContact: string };

function destination(customer: Recipient): { channel: "email" | "sms"; to: string } | null {
  if (customer.preferredContact === "email" && customer.email) return { channel: "email", to: customer.email };
  if (customer.phone) return { channel: "sms", to: customer.phone };
  if (customer.email) return { channel: "email", to: customer.email };
  return null;
}

async function send(
  customer: Recipient,
  input: { subject: string; lines: string[]; relatedEntityType: string; relatedEntityId: string },
): Promise<boolean> {
  const to = destination(customer);
  if (!to) return false;
  const settings = await getSettings();
  const body = [`Hi ${customer.firstName},`, "", ...input.lines, "", `— ${settings.businessName}`, settings.phone].join("\n");
  const result = await sendMessage({
    customerId: customer.id,
    channel: to.channel,
    kind: "membership",
    to: to.to,
    subject: to.channel === "email" ? input.subject : undefined,
    body,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
  });
  return result.sent;
}

async function loadMembership(membershipId: string) {
  const [row] = await db()
    .select({
      membership: schema.memberships,
      plan: schema.membershipPlans,
      customer: schema.customers,
      vehicle: schema.vehicles,
    })
    .from(schema.memberships)
    .innerJoin(schema.membershipPlans, eq(schema.membershipPlans.id, schema.memberships.planId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.memberships.vehicleId))
    .where(eq(schema.memberships.id, membershipId))
    .limit(1);
  return row ?? null;
}

function vehicleLabel(vehicle: { year: number | null; make: string; model: string }): string {
  return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
}

function accountLink(): string {
  return `${getAppBaseUrl()}/account`;
}

async function withTax(cents: number): Promise<string> {
  const settings = await getSettings();
  return formatCents(cents + taxCents(cents, settings.taxRateBp), settings.currency);
}

async function day(date: Date | null): Promise<string> {
  if (!date) return "";
  const settings = await getSettings();
  return formatInZone(date, settings.timezone, { month: "long", day: "numeric", year: "numeric" });
}

export async function sendMembershipWelcome(membershipId: string): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer, vehicle } = row;
  await send(customer, {
    subject: `Welcome to ${plan.name}`,
    lines: [
      `Welcome to ${plan.name} for your ${vehicleLabel(vehicle)}. Your first month is paid and your benefits start today.`,
      `Your plan renews on ${await day(membership.currentPeriodEnd)} at ${await withTax(membership.priceCents)} a month (tax included), charged to ${membership.cardLabel ?? "your card on file"}.`,
      `Book your member wash, see what's left this month, update your card or cancel any time in your account: ${accountLink()}`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendMembershipPaymentFailed(
  membershipId: string,
  options: { nextAttemptAt: Date | null },
): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer } = row;
  const next = options.nextAttemptAt ? await day(options.nextAttemptAt) : null;
  await send(customer, {
    subject: `We couldn't charge your card for ${plan.name}`,
    lines: [
      `Your monthly ${plan.name} payment of ${await withTax(membership.priceCents)} didn't go through on ${membership.cardLabel ?? "your card on file"}.`,
      next
        ? `We'll try again on ${next}. Your member benefits are paused until the payment goes through.`
        : "We weren't able to collect it after several tries, so your membership has ended.",
      `Update your card here: ${accountLink()}`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendMembershipEnded(membershipId: string, reason: "canceled" | "payment_failed"): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer } = row;
  await send(customer, {
    subject: `Your ${plan.name} membership has ended`,
    lines: [
      reason === "canceled"
        ? `Your ${plan.name} membership has ended as you asked. Thanks for being a member.`
        : `Your ${plan.name} membership has ended because we couldn't collect the monthly payment.`,
      `You're welcome back any time: ${getAppBaseUrl()}/winter`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendMembershipCancelScheduled(membershipId: string): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer } = row;
  await send(customer, {
    subject: `Your ${plan.name} cancellation is confirmed`,
    lines: [
      `Your ${plan.name} membership is cancelled. You won't be charged again.`,
      `Your benefits continue until the end of your paid month on ${await day(membership.currentPeriodEnd)}.`,
      `Changed your mind? You can keep your membership from your account before then: ${accountLink()}`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendMembershipUpgraded(membershipId: string, chargedCents: number): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer } = row;
  await send(customer, {
    subject: `You're now on ${plan.name}`,
    lines: [
      `Your membership is now ${plan.name}. We charged ${await withTax(chargedCents)} (tax included) for the difference this month, and your new benefits are available now.`,
      `From ${await day(membership.currentPeriodEnd)} your monthly price is ${await withTax(membership.priceCents)} (tax included).`,
      `Your account: ${accountLink()}`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendMembershipCardUpdated(membershipId: string): Promise<void> {
  const row = await loadMembership(membershipId);
  if (!row) return;
  const { membership, plan, customer } = row;
  await send(customer, {
    subject: "Your card on file was updated",
    lines: [
      `${membership.cardLabel ?? "Your new card"} is now the card for your ${plan.name} membership.`,
      `If you didn't make this change, call us right away.`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendPlanChangeNotice(membershipId: string): Promise<boolean> {
  const row = await loadMembership(membershipId);
  if (!row?.membership.nextPlanId) return false;
  const { membership, plan, customer } = row;
  const [next] = await db()
    .select()
    .from(schema.membershipPlans)
    .where(eq(schema.membershipPlans.id, membership.nextPlanId!))
    .limit(1);
  if (!next) return false;
  return send(customer, {
    subject: `Your membership is changing to ${next.name}`,
    lines: [
      `A heads-up: from your billing date on or after ${await day(membership.nextPlanFrom)}, your ${plan.name} membership moves to ${next.name} at ${await withTax(next.monthlyPriceCents)} a month (tax included).`,
      ...(next.features.length > 0 ? [`${next.name} includes: ${next.features.join("; ")}.`] : []),
      `There's nothing you need to do. To make changes or cancel, visit your account: ${accountLink()}`,
    ],
    relatedEntityType: "membership",
    relatedEntityId: membership.id,
  });
}

export async function sendWinterPassConfirmation(passId: string): Promise<void> {
  const [row] = await db()
    .select({ pass: schema.winterPasses, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.winterPasses)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.winterPasses.customerId))
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.winterPasses.vehicleId))
    .where(eq(schema.winterPasses.id, passId))
    .limit(1);
  if (!row || row.pass.status !== "active") return;
  const { pass, customer, vehicle } = row;
  await send(customer, {
    subject: "Your Winter Pass is ready",
    lines: [
      `Your Winter Pass for your ${vehicleLabel(vehicle)} is active: ${pass.washesTotal} winter hand washes, each with a free underbody salt flush.`,
      `Use them any time until ${await day(pass.validUntil)}.`,
      `Book a wash from your account: ${accountLink()}`,
    ],
    relatedEntityType: "winter_pass",
    relatedEntityId: pass.id,
  });
}
