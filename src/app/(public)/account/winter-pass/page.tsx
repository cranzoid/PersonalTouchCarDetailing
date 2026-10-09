import Link from "next/link";
import { and, inArray } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { membershipSettings } from "@/lib/memberships/config";
import { passValidityWindow } from "@/lib/memberships/passes";
import { formatInZone } from "@/lib/tz";
import { formatCents, taxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { PurchaseForm } from "../purchase-form";
import { SignIn } from "../sign-in";

export const metadata = { title: "Winter Pass", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function WinterPassPage() {
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const pass = config.winterPass;
  const total = formatCents(pass.priceCents + taxCents(pass.priceCents, settings.taxRateBp), settings.currency);
  const window = passValidityWindow(pass, settings.timezone);
  const day = (d: Date) => formatInZone(d, settings.timezone, { month: "long", day: "numeric", year: "numeric" });
  const session = await getAccountSession();
  const customers = session ? await accountCustomers(session) : [];
  const ids = customers.map((c) => c.id);
  const vehicles = ids.length ? await db().select().from(schema.vehicles).where(inArray(schema.vehicles.customerId, ids)) : [];
  const live = ids.length
    ? await db()
        .select({ vehicleId: schema.winterPasses.vehicleId })
        .from(schema.winterPasses)
        .where(and(inArray(schema.winterPasses.customerId, ids), inArray(schema.winterPasses.status, ["active"])))
    : [];

  return (
    <Container className="max-w-3xl py-10 sm:py-14">
      <Link href="/winter" className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline">← Winter plans</Link>
      <header className="mt-3 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Prepaid</p>
        <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">{pass.name}</h1>
        <p className="mt-2 text-lg text-white">
          {formatCents(pass.priceCents, settings.currency)} <span className="text-sm text-ink-400">+ {settings.taxLabel} ({total} total)</span>
        </p>
        <ul className="mt-4 grid gap-1.5 text-sm text-ink-200 sm:grid-cols-2">
          {pass.features.map((feature) => (
            <li key={feature} className="flex gap-2"><span aria-hidden="true" className="text-accent-300">✓</span>{feature}</li>
          ))}
        </ul>
      </header>
      <div className="mt-8">
        {!config.passSalesOpen ? (
          <p className="rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
            Online sales open soon. Call us on {settings.phone}, or pick one up at the shop.
          </p>
        ) : !session ? (
          <SignIn intro="First, sign in or create your account with your email or mobile number — your pass and its washes live there." />
        ) : (
          <PurchaseForm
            kind="pass"
            vehicles={vehicles.map((v) => ({ id: v.id, label: [v.year, v.make, v.model].filter(Boolean).join(" ") + (v.licencePlate ? ` (${v.licencePlate})` : "") }))}
            unavailableVehicleIds={live.map((p) => p.vehicleId)}
            needsName={customers.length === 0}
            payLabel={`Buy for ${total}`}
            successMessage="Your Winter Pass is ready. Book your first wash from your account."
            terms={[
              `${pass.washesTotal} winter hand washes for one car, each with a free underbody salt flush.`,
              `Washes can be used from ${day(window.validFrom)} to ${day(window.validUntil)}. Unused washes expire after that.`,
              "Prepaid in full today.",
            ]}
          />
        )}
      </div>
    </Container>
  );
}
