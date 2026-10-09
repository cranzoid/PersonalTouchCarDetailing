import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { MEMBERSHIP_BENEFITS, membershipSettings } from "@/lib/memberships/config";
import { getVehicleEntitlements } from "@/lib/memberships/service";
import { getSettings } from "@/lib/settings";
import { formatInZone, localDateISO } from "@/lib/tz";
import { MemberBookForm, type BookableVehicle } from "./book-form";

export const metadata = { title: "Book a Visit", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AccountBookPage({ searchParams }: { searchParams: Promise<{ vehicle?: string; use?: string }> }) {
  const session = await getAccountSession();
  if (!session) redirect("/account");
  const query = await searchParams;
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const customers = await accountCustomers(session);
  const ids = customers.map((c) => c.id);
  const vehicles = ids.length
    ? await db().select().from(schema.vehicles).where(inArray(schema.vehicles.customerId, ids)).orderBy(asc(schema.vehicles.createdAt))
    : [];

  const bookable: BookableVehicle[] = [];
  for (const vehicle of vehicles) {
    const { membership, passes } = await getVehicleEntitlements(vehicle.id);
    const pass = passes[0];
    bookable.push({
      id: vehicle.id,
      label: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" "),
      memberPlan: membership?.status === "active" ? membership.planName : null,
      discountPercent: membership?.status === "active" ? membership.discountBp / 100 : 0,
      benefits: membership?.status === "active"
        ? membership.included.map((key) => ({ key, label: MEMBERSHIP_BENEFITS[key].label, available: membership.available.includes(key) }))
        : [],
      benefitsUntil: membership?.currentPeriodEnd
        ? formatInZone(new Date(membership.currentPeriodEnd.getTime() - 1), settings.timezone, { month: "long", day: "numeric" })
        : null,
      passWashesLeft: pass ? pass.washesTotal - pass.washesUsed : 0,
      passFromISO: pass ? localDateISO(settings.timezone, Math.max(0, pass.validFrom.getTime() - Date.now())) : null,
    });
  }

  const packages = await db()
    .select({ id: schema.services.id, name: schema.services.name, slug: schema.services.slug })
    .from(schema.services)
    .where(and(inArray(schema.services.slug, config.discountServiceSlugs), eq(schema.services.active, true), eq(schema.services.bookingMode, "bookable")))
    .orderBy(asc(schema.services.sort));
  const links = packages.length
    ? await db()
        .select({ serviceId: schema.serviceAddons.serviceId, addonId: schema.addons.id, name: schema.addons.name })
        .from(schema.serviceAddons)
        .innerJoin(schema.addons, eq(schema.addons.id, schema.serviceAddons.addonId))
        .where(and(inArray(schema.serviceAddons.serviceId, packages.map((p) => p.id)), eq(schema.addons.active, true)))
    : [];

  const anyMember = bookable.some((v) => v.memberPlan);
  const maxDays = settings.maxBookingWindowDays + (anyMember ? config.priorityBookingExtraDays : 0);

  return (
    <Container className="max-w-3xl py-10 sm:py-14">
      <Link href="/account" className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline">← My account</Link>
      <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Book a visit</h1>
      {anyMember && (
        <p className="mt-2 text-sm text-ink-300">As a member you can book up to {maxDays} days ahead.</p>
      )}
      <div className="mt-8">
        {bookable.length === 0 ? (
          <p className="rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
            There&apos;s no car on your account yet. <Link href="/book" className="text-accent-300 underline-offset-4 hover:underline">Book online</Link> instead.
          </p>
        ) : (
          <MemberBookForm
            vehicles={bookable}
            packages={packages.map((p) => ({ id: p.id, name: p.name, addons: links.filter((l) => l.serviceId === p.id).map((l) => ({ id: l.addonId, name: l.name })) }))}
            initialVehicleId={query.vehicle}
            initialUse={query.use === "pass" || query.use === "package" || query.use === "member" ? query.use : undefined}
            minDateISO={localDateISO(settings.timezone, 86_400_000)}
            maxDateISO={localDateISO(settings.timezone, maxDays * 86_400_000)}
            taxLabel={settings.taxLabel}
          />
        )}
      </div>
    </Container>
  );
}
