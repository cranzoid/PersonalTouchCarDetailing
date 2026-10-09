import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";

/**
 * What an invoice being paid in full SETTLES, beyond the invoice itself.
 *
 * Memberships and Winter Passes are sold through ordinary invoices so that the
 * invoice stays the one tax document for everything the shop sells. That means
 * the moment of payment is the invoice reaching `paid` — however it got there:
 * the customer's card online, a card on file, the terminal, or cash at the
 * counter. Hanging this off `recalculateInvoiceStatus` is what makes every one
 * of those routes issue the pass or start the month, with no route able to
 * forget to.
 *
 * Only reads and updates; it must never insert, because it runs inside the
 * invoice's own locked transaction from several call sites.
 */
export async function settlePaidInvoice(
  tx: Pick<Db, "select" | "update" | "insert">,
  invoiceId: string,
  now = new Date(),
): Promise<void> {
  // --- Winter Pass sold on this invoice ------------------------------------
  const passes = await tx
    .select()
    .from(schema.winterPasses)
    .where(and(eq(schema.winterPasses.saleInvoiceId, invoiceId), eq(schema.winterPasses.status, "pending_payment")))
    .for("update");
  for (const pass of passes) {
    await tx
      .update(schema.winterPasses)
      .set({ status: "active", activatedAt: now, updatedAt: now })
      .where(eq(schema.winterPasses.id, pass.id));
    await audit(tx, {
      actorType: "system",
      action: "winter_pass.activated",
      entityType: "winter_pass",
      entityId: pass.id,
      after: { invoiceId, washesTotal: pass.washesTotal, validUntil: pass.validUntil.toISOString() },
    });
  }

  // --- A membership month billed on this invoice ---------------------------
  const periods = await tx
    .select()
    .from(schema.membershipPeriods)
    .where(
      and(
        eq(schema.membershipPeriods.invoiceId, invoiceId),
        inArray(schema.membershipPeriods.status, ["due", "failed"]),
      ),
    )
    .for("update");
  for (const period of periods) {
    await tx
      .update(schema.membershipPeriods)
      .set({ status: "paid", lastError: null, updatedAt: now })
      .where(eq(schema.membershipPeriods.id, period.id));

    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, period.membershipId))
      .for("update");
    if (!membership || membership.status === "canceled") continue;

    // A month only ever moves the membership FORWARD. Paying an old failed
    // month late (cash at the counter) must not wind the current period back.
    const advances = !membership.currentPeriodEnd || period.periodEnd > membership.currentPeriodEnd;
    const planChanged = advances && period.planId !== membership.planId;
    await tx
      .update(schema.memberships)
      .set({
        status: "active",
        ...(advances ? { currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd } : {}),
        // The season changing over: the month was billed on the next plan, so
        // paying it is what moves the member onto it.
        ...(planChanged
          ? { planId: period.planId, priceCents: period.amountCents, nextPlanId: null, nextPlanFrom: null }
          : {}),
        failedAttempts: 0,
        nextAttemptAt: null,
        pastDueSince: null,
        updatedAt: now,
      })
      .where(eq(schema.memberships.id, membership.id));
    await audit(tx, {
      actorType: "system",
      action: membership.status === "pending" ? "membership.activated" : "membership.period_paid",
      entityType: "membership",
      entityId: membership.id,
      before: { status: membership.status, planId: membership.planId },
      after: {
        status: "active",
        periodId: period.id,
        invoiceId,
        periodEnd: period.periodEnd.toISOString(),
        planId: planChanged ? period.planId : membership.planId,
      },
    });
  }
}

/**
 * Applies an upgrade once its charge has settled. Called from inside the
 * checkout finalizer's transaction, whichever path confirmed the payment.
 */
export async function applyPaidUpgrade(tx: Pick<Db, "select" | "update" | "insert">, membershipId: string, toPlanId: string): Promise<void> {
  const [membership] = await tx.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).for("update");
  const [plan] = await tx.select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, toPlanId));
  if (!membership || !plan || membership.planId === plan.id) return;
  await tx
    .update(schema.memberships)
    .set({ planId: plan.id, priceCents: plan.monthlyPriceCents, updatedAt: new Date() })
    .where(eq(schema.memberships.id, membership.id));
  await audit(tx, {
    actorType: "system",
    action: "membership.upgraded",
    entityType: "membership",
    entityId: membership.id,
    before: { planId: membership.planId, priceCents: membership.priceCents },
    after: { planId: plan.id, priceCents: plan.monthlyPriceCents },
  });
}
