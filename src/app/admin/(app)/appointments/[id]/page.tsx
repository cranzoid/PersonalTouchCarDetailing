import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { TransitionButtons } from "./transition-buttons";
import { CheckInButton } from "./check-in-button";
import { requirePageStaff } from "@/lib/auth/page";
import { ReschedulePanel } from "./reschedule-panel";
import { RevisePanel } from "./revise-panel";
import { DepositRefundPanel } from "./deposit-refund-panel";
import { CreateInvoicePanel } from "./create-invoice-panel";

export const dynamic = "force-dynamic";

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageStaff("manage_bookings");
  const { id } = await params;
  const settings = await getSettings();

  const rows = await db().select().from(schema.appointments).where(eq(schema.appointments.id, id)).limit(1);
  const appt = rows[0];
  if (!appt) notFound();

  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, appt.customerId)).limit(1);
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, appt.vehicleId)).limit(1);
  const lines = await db()
    .select()
    .from(schema.appointmentServices)
    .where(eq(schema.appointmentServices.appointmentId, id))
    .orderBy(asc(schema.appointmentServices.sort));
  const resource = appt.resourceId
    ? (await db().select().from(schema.resources).where(eq(schema.resources.id, appt.resourceId)).limit(1))[0]
    : null;

  const attr = appt.attribution as Record<string, unknown> | null;

  // Catalog for the "Change packages" panel — the same filter the manual
  // booking builder uses, so staff see one consistent list of what is bookable.
  const [services, categories, addonLinks, addons] = await Promise.all([
    db().select().from(schema.services).where(and(
      eq(schema.services.active, true),
      eq(schema.services.bookingMode, "bookable"),
      isNotNull(schema.services.basePriceCents),
    )).orderBy(asc(schema.services.sort)),
    db().select().from(schema.serviceCategories).orderBy(asc(schema.serviceCategories.sort)),
    db().select().from(schema.serviceAddons),
    db().select().from(schema.addons).where(eq(schema.addons.active, true)).orderBy(asc(schema.addons.sort)),
  ]);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  // Mirrors REVISABLE in lib/booking/revise.ts, `completed` included: a visit
  // that is over can still be corrected until the money settles, and the guard
  // that actually stops a settled sale is the draft-invoice check inside the
  // action, not the stage (DECISIONS.md §21). This list omitted `completed`
  // while the server allowed it, so the panel was unreachable for the exact
  // case it was widened for. The action re-checks under a row lock, so this is
  // presentation, not enforcement.
  const canRevise = [
    "pending",
    "deposit_required",
    "confirmed",
    "arrived",
    "converted",
    "completed",
  ].includes(appt.status);
  // The invoice a finished visit produced, reached through its job — invoices
  // hang off `jobs`, and an appointment invoiced from this screen has the job
  // materialised for it by createInvoiceFromAppointmentAction.
  const job = appt.jobId
    ? (await db().select().from(schema.jobs).where(eq(schema.jobs.id, appt.jobId)).limit(1))[0]
    : undefined;
  const [invoice] = job?.invoiceId
    ? await db()
        .select({ id: schema.invoices.id, number: schema.invoices.number, status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, job.invoiceId))
        .limit(1)
    : [];

  // Derived, never stored: the deposit held that the current total cannot
  // absorb. See refundAppointmentDepositAction.
  const depositRefundableCents = Math.max(0, appt.depositPaidCents - appt.totalCents);
  const depositPayments = depositRefundableCents > 0
    ? await db().select({ provider: schema.payments.provider })
        .from(schema.payments)
        .where(and(
          eq(schema.payments.appointmentId, appt.id),
          eq(schema.payments.kind, "deposit"),
          eq(schema.payments.status, "succeeded"),
        ))
    : [];

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{appt.id}</p>
          <h1 className="text-2xl font-bold text-white">
            {formatInZone(appt.startsAt, settings.timezone, {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            Until {formatInZone(appt.endsAt, settings.timezone, { hour: "numeric", minute: "2-digit" })}
            {resource ? ` · ${resource.name}` : ""} · {appt.durationMin} min work
          </p>
        </div>
        <StatusBadge status={appt.status} />
      </div>

      <TransitionButtons
        appointmentId={appt.id}
        status={appt.status}
        depositRequiredCents={appt.depositRequiredCents}
        depositPaidCents={appt.depositPaidCents}
      />
      {["pending", "deposit_required", "confirmed"].includes(appt.status) && (
        <ReschedulePanel appointmentId={appt.id} maxBookingWindowDays={settings.maxBookingWindowDays} timezone={settings.timezone} />
      )}
      {/* Check-in works straight from confirmed — arrival is recorded by the
          same action, so staff do not need a separate "Mark Arrived" click. */}
      {["confirmed", "arrived"].includes(appt.status) && !appt.jobId && (
        <CheckInButton appointmentId={appt.id} />
      )}
      {appt.jobId && (
        <p className="mt-4 text-sm">
          <Link href={`/admin/jobs/${appt.jobId}`} className="text-accent-300 hover:underline">
            View job →
          </Link>
        </p>
      )}

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Customer</h2>
          {customer ? (
            <div className="mt-2 text-sm">
              <Link href={`/admin/customers/${customer.id}`} className="font-medium text-accent-300 hover:underline">
                {customer.firstName} {customer.lastName}
              </Link>
              {customer.email && <p className="text-ink-300">{customer.email}</p>}
              {customer.phone && <p className="text-ink-300">{customer.phone}</p>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-500">Missing customer record</p>
          )}
        </section>
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Vehicle</h2>
          {vehicle ? (
            <p className="mt-2 text-sm text-ink-300">
              {vehicle.year ?? ""} {vehicle.make} {vehicle.model}
              {vehicle.colour ? ` · ${vehicle.colour}` : ""} · {vehicle.category}
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink-500">Missing vehicle record</p>
          )}
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-ink-800 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Services</h2>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-ink-800/60 first:border-0">
                <td className="py-2 text-ink-200">{l.description}</td>
                <td className="py-2 text-right text-ink-400">{l.durationMin} min</td>
                <td className="py-2 text-right text-ink-200">{formatCents(l.priceCents)}</td>
              </tr>
            ))}
            <tr className="border-t border-ink-700">
              <td className="py-2 text-ink-400">Subtotal</td>
              <td />
              <td className="py-2 text-right text-ink-200">{formatCents(appt.subtotalCents)}</td>
            </tr>
            {appt.discountCents > 0 && (
              <tr>
                <td className="py-1 text-emerald-300">
                  {appt.promoLabel ?? "Discount"}
                  {appt.promoCode ? ` (${appt.promoCode})` : ""}
                </td>
                <td />
                <td className="py-1 text-right text-emerald-300">−{formatCents(appt.discountCents)}</td>
              </tr>
            )}
            <tr>
              <td className="py-1 text-ink-400">Tax ({(appt.taxRateBp / 100).toFixed(2)}%)</td>
              <td />
              <td className="py-1 text-right text-ink-200">{formatCents(appt.taxCents)}</td>
            </tr>
            <tr>
              <td className="py-2 font-semibold text-white">Total</td>
              <td />
              <td className="py-2 text-right font-semibold text-accent-300">{formatCents(appt.totalCents)}</td>
            </tr>
          </tbody>
        </table>
        {appt.depositRequiredCents > 0 && (
          <p className="mt-2 text-sm text-amber-300">
            Deposit required: {formatCents(appt.depositRequiredCents)} (paid:{" "}
            {formatCents(appt.depositPaidCents)})
          </p>
        )}
        {appt.revisedAt && (
          <p className="mt-2 text-xs text-ink-500">
            Packages changed at the counter on{" "}
            {formatInZone(appt.revisedAt, settings.timezone, { month: "short", day: "numeric" })}
            {appt.originalSubtotalCents !== null
              ? ` · originally booked at ${formatCents(appt.originalSubtotalCents)}`
              : ""}
          </p>
        )}
      </section>

      {canRevise && (
        <RevisePanel
          appointmentId={appt.id}
          services={services.map((service) => ({
            id: service.id,
            name: service.name,
            categoryName: categoryNames.get(service.categoryId) ?? "Services",
            basePriceCents: service.basePriceCents!,
            addonIds: addonLinks.filter((link) => link.serviceId === service.id).map((link) => link.addonId),
          }))}
          addons={addons.map((addon) => ({ id: addon.id, name: addon.name, priceCents: addon.priceCents }))}
          initialServiceIds={lines.flatMap((line) => (line.serviceId ? [line.serviceId] : []))}
          initialAddonIds={lines.flatMap((line) => (line.addonId ? [line.addonId] : []))}
          initialCustomLines={lines
            .filter((line) => !line.serviceId && !line.addonId)
            .map((line) => ({
              description: line.description,
              priceCents: line.priceCents,
              durationMin: line.durationMin,
            }))}
          currentDiscountCents={appt.discountCents}
          promoLabel={appt.promoLabel}
          currency={settings.currency}
        />
      )}

      {invoice ? (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Invoice</h2>
          <Link
            href={`/admin/invoices/${invoice.id}`}
            className="mt-2 inline-block text-accent-300 hover:underline"
          >
            Invoice #{invoice.number} ({invoice.status.replaceAll("_", " ")}) →
          </Link>
        </section>
      ) : (
        appt.status === "completed" &&
        lines.length > 0 && (
          <CreateInvoicePanel
            appointmentId={appt.id}
            lineCount={lines.length}
            totalCents={appt.totalCents}
            depositPaidCents={appt.depositPaidCents}
            currency={settings.currency}
          />
        )
      )}

      {depositRefundableCents > 0 && (
        <DepositRefundPanel
          appointmentId={appt.id}
          refundableCents={depositRefundableCents}
          depositPaidCents={appt.depositPaidCents}
          currency={settings.currency}
          originalMethodWasCard={depositPayments.some((p) => p.provider === "stripe")}
        />
      )}

      {appt.customerNotes && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Customer notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-300">{appt.customerNotes}</p>
        </section>
      )}

      {appt.cancellationReason && (
        <section className="mt-6 rounded-xl border border-red-900/50 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-red-400">Cancellation</h2>
          <p className="mt-2 text-sm text-ink-300">{appt.cancellationReason}</p>
        </section>
      )}

      {attr && Object.keys(attr).length > 0 && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Marketing attribution</h2>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {Object.entries(attr)
              .filter(([, v]) => typeof v === "string" && v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="truncate text-ink-300">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
    </div>
  );
}
