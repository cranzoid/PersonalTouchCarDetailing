import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { Container } from "@/components/ui";
import { HelcimCheckoutButton } from "@/components/helcim-checkout";
import { db, schema } from "@/db";
import { resolveAppointmentDepositToken } from "@/lib/appointment-deposits";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { appointmentWhenLabel } from "@/lib/appointment-time";
import { confirmAppointmentPaymentAction, startAppointmentPaymentAction } from "./actions";

export const metadata = { title: "Your Appointment" };
export const dynamic = "force-dynamic";

export default async function AppointmentDepositPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveAppointmentDepositToken(token);
  if (!resolved) notFound();

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
  const balanceCents = Math.max(0, appointment.totalCents - appointment.depositPaidCents);
  const cancelled = appointment.status === "cancelled";
  const closed = cancelled || ["no_show", "completed", "converted", "arrived"].includes(appointment.status);
  const needsDeposit = !closed && appointment.status === "deposit_required" && outstandingCents > 0;
  const confirmed = !cancelled && outstandingCents === 0 && appointment.depositRequiredCents > 0;

  return (
    <Container className="max-w-2xl py-10 sm:py-16">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
        <h1 className="mt-3 text-3xl font-bold text-white">{needsDeposit ? "Confirm your appointment" : "Your appointment"}</h1>
        <p className="mt-3 text-sm leading-6 text-ink-300">
          {appointmentWhenLabel(appointment, settings.timezone, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </header>

      <section aria-labelledby="deposit-summary" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-5 shadow-xl shadow-black/10 sm:p-6">
        <h2 id="deposit-summary" className="text-lg font-semibold text-white">Booking summary</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Customer</dt><dd className="text-right text-ink-200">{customer?.firstName} {customer?.lastName}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Vehicle</dt><dd className="text-right text-ink-200">{[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ")}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-400">Services</dt><dd className="max-w-sm text-right text-ink-200">{lines.map((line) => line.description).join(", ")}</dd></div>
          {appointment.discountCents > 0 && (
            <div className="flex justify-between gap-4"><dt className="text-emerald-300">{appointment.promoLabel ?? "Discount"}</dt><dd className="text-right text-emerald-300">−{formatCents(appointment.discountCents, settings.currency)}</dd></div>
          )}
          <div className="border-t border-ink-700 pt-3 flex justify-between gap-4"><dt className="text-ink-300">Estimated total</dt><dd className="font-medium text-white">{formatCents(appointment.totalCents, settings.currency)}</dd></div>
          {appointment.depositPaidCents > 0 && (
            <div className="flex justify-between gap-4"><dt className="text-ink-400">Paid so far</dt><dd className="text-right text-ink-200">−{formatCents(appointment.depositPaidCents, settings.currency)}</dd></div>
          )}
          {needsDeposit ? (
            <div className="flex justify-between gap-4"><dt className="font-medium text-ink-200">Deposit due</dt><dd className="text-lg font-semibold text-accent-300">{formatCents(outstandingCents, settings.currency)}</dd></div>
          ) : (
            <div className="flex justify-between gap-4"><dt className="font-medium text-ink-200">Balance</dt><dd className="text-lg font-semibold text-accent-300">{formatCents(balanceCents, settings.currency)}</dd></div>
          )}
        </dl>
      </section>

      {cancelled ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">This appointment was cancelled and is no longer payable.</div>
      ) : closed ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
          This visit is finished. Any balance is on your invoice — call {settings.phone} if you need a copy.
        </div>
      ) : needsDeposit ? (
        <div className="mt-6 space-y-5 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-6 shadow-xl shadow-black/15">
          <p className="text-sm leading-6 text-ink-300">Your time is being held, but it is not confirmed until the deposit is paid.</p>
          <HelcimCheckoutButton
            label={`Pay ${formatCents(outstandingCents, settings.currency)} deposit`}
            start={startAppointmentPaymentAction.bind(null, token, "deposit")}
            confirm={confirmAppointmentPaymentAction.bind(null, token)}
            successMessage="Deposit received — your appointment is confirmed."
          />
          {balanceCents > outstandingCents && (
            <details className="text-sm text-ink-300">
              <summary className="cursor-pointer text-accent-300">Or pay the full {formatCents(balanceCents, settings.currency)} now</summary>
              <div className="mt-4">
                <HelcimCheckoutButton
                  label={`Pay ${formatCents(balanceCents, settings.currency)} in full`}
                  start={startAppointmentPaymentAction.bind(null, token, "prepay")}
                  confirm={confirmAppointmentPaymentAction.bind(null, token)}
                  successMessage="Payment received — your appointment is confirmed and paid."
                />
              </div>
            </details>
          )}
        </div>
      ) : balanceCents > 0 ? (
        <div className="mt-6 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-6 shadow-xl shadow-black/15">
          {confirmed && (
            <p className="mb-4 text-sm text-emerald-300">Your deposit has been received and your appointment is confirmed.</p>
          )}
          <p className="mb-4 text-sm leading-6 text-ink-300">
            Pay ahead online if you like — or simply pay at the shop. If the work changes on the day, we&apos;ll settle the difference then.
          </p>
          <HelcimCheckoutButton
            label={`Pay ${formatCents(balanceCents, settings.currency)} now`}
            start={startAppointmentPaymentAction.bind(null, token, "prepay")}
            confirm={confirmAppointmentPaymentAction.bind(null, token)}
            successMessage="Payment received — you're all set."
          />
        </div>
      ) : (
        <div role="status" className="mt-6 rounded-2xl border border-emerald-500/25 bg-emerald-950/20 p-6 text-emerald-300">
          {appointment.depositPaidCents > 0
            ? "Paid in full — thank you. Keep this page and the reference below as your confirmation."
            : "Nothing is due for this appointment."}
        </div>
      )}

      <p className="mt-8 text-xs text-ink-500">This secure link is personal to you and expires automatically. Reference: {appointment.id}</p>
    </Container>
  );
}
