import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { membershipSettings } from "@/lib/memberships/config";
import { listPlans } from "@/lib/memberships/service";
import { formatCents, taxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { PurchaseForm } from "../purchase-form";
import { SignIn } from "../sign-in";

export const metadata = { title: "Join", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan: slug } = await searchParams;
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const plans = await listPlans({ activeOnly: true });
  const plan = plans.find((p) => p.slug === slug) ?? plans[0];
  if (!plan) {
    return (
      <Container className="py-16">
        <p className="text-ink-300">No plans are available right now.</p>
      </Container>
    );
  }
  const withTax = (cents: number) => formatCents(cents + taxCents(cents, settings.taxRateBp), settings.currency);
  const session = await getAccountSession();

  return (
    <Container className="max-w-3xl py-10 sm:py-14">
      <Link href="/winter" className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline">← Winter plans</Link>
      <header className="mt-3 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Join</p>
        <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">{plan.name}</h1>
        <p className="mt-2 text-lg text-white">
          {formatCents(plan.monthlyPriceCents, settings.currency)}/month <span className="text-sm text-ink-400">+ {settings.taxLabel} ({withTax(plan.monthlyPriceCents)} total)</span>
        </p>
        {plan.features.length > 0 && (
          <ul className="mt-4 grid gap-1.5 text-sm text-ink-200 sm:grid-cols-2">
            {plan.features.map((feature) => (
              <li key={feature} className="flex gap-2"><span aria-hidden="true" className="text-accent-300">✓</span>{feature}</li>
            ))}
          </ul>
        )}
        {plans.length > 1 && (
          <p className="mt-4 text-sm text-ink-400">
            Other plans:{" "}
            {plans.filter((p) => p.id !== plan.id).map((p, i) => (
              <span key={p.id}>
                {i > 0 && " · "}
                <Link href={`/account/join?plan=${p.slug}`} className="text-accent-300 underline-offset-4 hover:underline">{p.name}</Link>
              </span>
            ))}
          </p>
        )}
      </header>

      <div className="mt-8">
        {!config.salesOpen ? (
          <p className="rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
            Online sign-up opens soon. Call us on {settings.phone} to join today.
          </p>
        ) : !session ? (
          <SignIn intro="First, sign in or create your account with your email or mobile number. We'll send a 6-digit code." />
        ) : (
          <JoinForm planId={plan.id} planName={plan.name} priceLabel={withTax(plan.monthlyPriceCents)} />
        )}
      </div>
    </Container>
  );
}

async function JoinForm({ planId, planName, priceLabel }: { planId: string; planName: string; priceLabel: string }) {
  const session = (await getAccountSession())!;
  const customers = await accountCustomers(session);
  const ids = customers.map((c) => c.id);
  const vehicles = ids.length
    ? await db().select().from(schema.vehicles).where(inArray(schema.vehicles.customerId, ids))
    : [];
  const live = ids.length
    ? await db()
        .select({ vehicleId: schema.memberships.vehicleId })
        .from(schema.memberships)
        .where(and(inArray(schema.memberships.customerId, ids), inArray(schema.memberships.status, ["active", "past_due"])))
    : [];
  return (
    <PurchaseForm
      kind="membership"
      planId={planId}
      vehicles={vehicles.map((v) => ({ id: v.id, label: [v.year, v.make, v.model].filter(Boolean).join(" ") + (v.licencePlate ? ` (${v.licencePlate})` : "") }))}
      unavailableVehicleIds={live.map((m) => m.vehicleId)}
      needsName={customers.length === 0}
      payLabel={`Join for ${priceLabel} today`}
      successMessage={`Welcome to ${planName}! Your benefits start today.`}
      terms={[
        `${planName} is for one car. Benefits can't be shared with another vehicle.`,
        `Your card is charged ${priceLabel} (tax included) today and on the same day each month until you cancel.`,
        "Monthly benefits don't roll over to the next month.",
        "Cancel any time from your account. Cancelling takes effect at the end of the month you've paid for, and payments already made aren't refunded.",
        "If a monthly payment fails, benefits pause until it goes through. We'll retry and let you know.",
        "If the plan changes (for example when the season changes), we'll tell you before it takes effect.",
      ]}
    />
  );
}
