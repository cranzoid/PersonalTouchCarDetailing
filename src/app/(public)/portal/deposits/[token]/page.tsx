import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import {
  resolveAppointmentDepositToken,
  sendAppointmentDepositConfirmation,
} from "@/lib/appointment-deposits";
import { formatCents } from "@/lib/money";
import { finalizeSucceededAppointmentDeposit } from "@/lib/payments";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { DepositPayButton } from "./pay-button";

export const metadata = { title: "Confirm Your Appointment" };
export const dynamic = "force-dynamic";

export default async function AppointmentDepositPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ fake_session?: string; payment_id?: string; amount_cents?: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveAppointmentDepositToken(token);
  if (!resolved) notFound();

  const query = await searchParams;
  if (query.fake_session && query.payment_id && query.amount_cents && process.env.NODE_ENV !== "production") {
    const amountCents = Number(query.amount_cents);
    if (Number.isSafeInteger(amountCents) && amountCents > 0) {
      const [payment] = await db()
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, query.payment_id))
        .limit(1);
      if (
        payment?.appointmentId === resolved.appointment.id &&
        payment.customerId === resolved.appointment.customerId &&
        payment.provider === "fake" &&
        payment.providerRef === query.fake_session &&
        payment.amountCents === amountCents
      ) {
        const outcome = await db().transaction((tx) =>
          finalizeSucceededAppointmentDeposit(tx, {
            paymentId: payment.id,
            appointmentId: resolved.appointment.id,
            provider: "fake",
            providerRef: query.fake_session!,
            amountCents,
          }),
        );
        if (outcome && !outcome.alreadyProcessed) {
          try {
            await sendAppointmentDepositConfirmation(outcome.appointmentId, outcome.amountCents);
          } catch {
            console.error("Appointment deposit confirmation could not be queued after fake payment");
          }
        }
      }
    }
    redirect(`/portal/deposits/${token}`);
  }

  const [appointment] = await db()
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.id, resolved.appointment.id))
    .limit(1);
  if (!appointment || appointment.customerId !== resolved.token.customerId) notFound();
  const [[customer], [vehicle], lines, settings] = await Promise.all([
    db().select().from(schema.customers).where(eq(schema.customers.id, appointment.customerId)).limit(1),
    db().select().from(schema.vehicles).where(eq(schema.vehicles.id, appointment.vehicleId)).limit(1),
    db()
      .select()
      .from(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointment.id))
      .orderBy(asc(schema.appointmentServices.sort)),
    getSettings(),
  ]);
  const outstandingCents = Math.max(0, appointment.depositRequiredCents - appointment.depositPaidCents);
  const cancelled = appointment.status === "cancelled";
  const confirmed = !cancelled && outstandingCents === 0 && appointment.depositRequiredCents > 0;

  return (
    <Container className="max-w-2xl py-10 sm:py-16">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
        <h1 className="mt-3 text-3xl font-bold text-white">{confirmed ? "Appointment confirmed" : "Confirm your appointment"}</h1>
        <p className="mt-3 text-sm leading-6 text-ink-300">
          {formatInZone(appointment.startsAt, settings.timezone, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </header>

      <section aria-labelledby="deposit-summary" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-5 shadow-xl shadow-black/10 sm:p-6">
        <h2 id="deposit-summary" className="text-lg font-semibold text-white">Booking summary</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Customer</dt><dd className="text-right text-ink-200">{customer?.firstName} {customer?.lastName}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Vehicle</dt><dd className="text-right text-ink-200">{[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ")}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Services</dt><dd className="max-w-sm text-right text-ink-200">{lines.map((line) => line.description).join(", ")}</dd></div>
          <div className="border-t border-ink-700 pt-3 flex justify-between gap-4"><dt className="text-ink-300">Estimated total</dt><dd className="font-medium text-white">{formatCents(appointment.totalCents, settings.currency)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="font-medium text-ink-200">Deposit due</dt><dd className="text-lg font-semibold text-accent-300">{formatCents(outstandingCents, settings.currency)}</dd></div>
        </dl>
      </section>

      {cancelled ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">This appointment was cancelled and is no longer payable.</div>
      ) : confirmed ? (
        <div role="status" className="mt-6 rounded-2xl border border-emerald-500/25 bg-emerald-950/20 p-6 text-emerald-300">
          Your deposit has been received and your appointment is confirmed. Keep this secure page and the reference below as your payment confirmation.
        </div>
      ) : (
        <div className="mt-6 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-6 shadow-xl shadow-black/15">
          <p className="mb-4 text-sm leading-6 text-ink-300">Your time is being held, but it is not confirmed until the exact deposit is paid.</p>
          <DepositPayButton token={token} />
          <p className="mt-3 text-center text-xs text-ink-500">Secure checkout. The remaining estimated balance is due according to your service terms.</p>
        </div>
      )}

      <p className="mt-8 text-xs text-ink-500">This secure link is personal to you and expires automatically. Reference: {appointment.id}</p>
    </Container>
  );
}
