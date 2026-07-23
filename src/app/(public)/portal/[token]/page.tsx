import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { resolveCustomerPortalToken } from "@/lib/portal";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

export const metadata = { title: "Customer Portal" };
export const dynamic = "force-dynamic";

export default async function CustomerPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) notFound();
  const { customer } = resolved;
  const settings = await getSettings();
  const [vehicles, appointments, estimates, jobs, invoices] = await Promise.all([
    db().select().from(schema.vehicles).where(eq(schema.vehicles.customerId, customer.id)).orderBy(desc(schema.vehicles.createdAt)),
    db().select().from(schema.appointments).where(eq(schema.appointments.customerId, customer.id)).orderBy(desc(schema.appointments.startsAt)).limit(50),
    db().select().from(schema.estimates).where(and(eq(schema.estimates.customerId, customer.id), ne(schema.estimates.status, "draft"))).orderBy(desc(schema.estimates.createdAt)).limit(50),
    db().select().from(schema.jobs).where(eq(schema.jobs.customerId, customer.id)).orderBy(desc(schema.jobs.createdAt)).limit(50),
    db().select().from(schema.invoices).where(and(eq(schema.invoices.customerId, customer.id), ne(schema.invoices.status, "draft"))).orderBy(desc(schema.invoices.createdAt)).limit(50),
  ]);
  const vehiclesById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const displayName = customer.customerType === "business" && customer.companyName
    ? customer.companyName
    : `${customer.firstName} ${customer.lastName}`;

  return (
    <Container className="max-w-5xl py-10 sm:py-14">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] via-[#0B2A4A]/80 to-ink-950 p-6 shadow-2xl shadow-black/25 sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">Welcome, {displayName}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-300">Your secure view of vehicles, upcoming visits, estimates, service history and invoices.</p>
      </header>

      <section aria-labelledby="portal-vehicles" className="mt-10">
        <PortalHeading title="Vehicles" count={vehicles.length} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((vehicle) => (
            <div key={vehicle.id} className="rounded-2xl border border-ink-700/70 bg-ink-900/60 p-5 shadow-lg shadow-black/10">
              <p className="font-medium text-white">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</p>
              <p className="mt-1 text-sm capitalize text-ink-400">{vehicle.category.replaceAll("_", " ")}{vehicle.colour ? ` · ${vehicle.colour}` : ""}</p>
              {vehicle.licencePlate && <p className="mt-2 font-mono text-xs text-ink-500">{vehicle.licencePlate}</p>}
            </div>
          ))}
          {vehicles.length === 0 && <Empty>No vehicles are on file yet.</Empty>}
        </div>
      </section>

      <section aria-labelledby="portal-appointments" className="mt-10">
        <PortalHeading title="Appointments" count={appointments.length} />
        <div className="mt-3 space-y-2">
          {appointments.map((appointment) => {
            const vehicle = vehiclesById.get(appointment.vehicleId);
            return <div key={appointment.id} className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-ink-700/70 bg-ink-900/60 p-5 text-sm shadow-lg shadow-black/10 sm:flex-row sm:items-center">
              <span><span className="block font-medium text-white">{formatInZone(appointment.startsAt, settings.timezone, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span><span className="text-xs text-ink-500">{vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "Vehicle"}</span></span>
              <span className="flex w-full items-center justify-between gap-3 sm:w-auto"><span className="text-ink-200">{formatCents(appointment.totalCents, settings.currency)}</span><PortalStatus status={appointment.status} /></span>
            </div>;
          })}
          {appointments.length === 0 && <Empty>No appointments yet.</Empty>}
        </div>
      </section>

      <section aria-labelledby="portal-estimates" className="mt-10">
        <PortalHeading title="Estimates" count={estimates.length} />
        <div className="mt-3 space-y-2">
          {estimates.map((estimate) => (
            <Link key={estimate.id} href={`/portal/${token}/estimates/${estimate.id}`} className="flex min-h-14 items-center justify-between rounded-2xl border border-ink-700/70 bg-ink-900/60 p-4 text-sm shadow-lg shadow-black/10 transition-colors hover:border-accent-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">
              <span className="font-medium text-white">EST-{estimate.number}</span><PortalStatus status={estimate.status} />
            </Link>
          ))}
          {estimates.length === 0 && <Empty>No estimates yet.</Empty>}
        </div>
      </section>

      <section aria-labelledby="portal-history" className="mt-10">
        <PortalHeading title="Service history" count={jobs.length} />
        <div className="mt-3 space-y-2">
          {jobs.map((job) => {
            const vehicle = vehiclesById.get(job.vehicleId);
            return <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-700/70 bg-ink-900/60 p-5 text-sm shadow-lg shadow-black/10">
              <span><span className="block font-medium text-white">{vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "Vehicle service"}</span><span className="text-xs text-ink-500">{job.completedAt ? `Completed ${formatInZone(job.completedAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}` : `Opened ${formatInZone(job.createdAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}`}</span></span>
              <PortalStatus status={job.status} />
            </div>;
          })}
          {jobs.length === 0 && <Empty>No service history yet.</Empty>}
        </div>
      </section>

      <section aria-labelledby="portal-invoices" className="mt-10">
        <PortalHeading title="Invoices" count={invoices.length} />
        <div className="mt-3 space-y-2">
          {invoices.map((invoice) => (
            <Link key={invoice.id} href={`/portal/${token}/invoices/${invoice.id}`} className="flex min-h-14 items-center justify-between rounded-2xl border border-ink-700/70 bg-ink-900/60 p-4 text-sm shadow-lg shadow-black/10 transition-colors hover:border-accent-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">
              <span><span className="block font-medium text-white">INV-{invoice.number}</span><span className="text-xs text-ink-500">{formatInZone(invoice.createdAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</span></span>
              <span className="flex items-center gap-3"><span className="text-ink-300">{formatCents(invoice.totalCents, settings.currency)}</span><PortalStatus status={invoice.status} /></span>
            </Link>
          ))}
          {invoices.length === 0 && <Empty>No invoices yet.</Empty>}
        </div>
      </section>

      <p className="mt-12 text-xs text-ink-500">This link is personal to you. Do not share it. Questions? {settings.phone} · {settings.email}</p>
    </Container>
  );
}

function PortalHeading({ title, count }: { title: string; count: number }) {
  const id = `portal-${title === "Service history" ? "history" : title.toLowerCase()}`;
  return <h2 id={id} className="text-xl font-semibold text-white">{title} <span className="ml-1 rounded-full bg-[#0B2A4A] px-2.5 py-1 text-xs font-medium text-accent-300">{count}</span></h2>;
}
function PortalStatus({ status }: { status: string }) {
  return <span className="rounded-full border border-accent-500/25 bg-[#0B2A4A]/60 px-2.5 py-1 text-xs capitalize text-ink-200">{status.replaceAll("_", " ")}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-ink-700 bg-ink-900/25 p-5 text-sm text-ink-400">{children}</p>;
}
