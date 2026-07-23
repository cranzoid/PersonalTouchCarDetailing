import { randomBytes } from "crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { hashToken } from "@/lib/estimates";
import { newId } from "@/lib/id";
import { formatCents } from "@/lib/money";
import { sendMessage } from "@/lib/messaging";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Creates a purpose-bound appointment deposit link; only its hash is stored. */
export async function createAppointmentDepositAccessToken(
  tx: Pick<Db, "insert" | "update">,
  input: { appointmentId: string; customerId: string; expiresAt: Date },
): Promise<string> {
  await tx
    .update(schema.accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.accessTokens.purpose, "appointment_deposit"),
        eq(schema.accessTokens.subjectType, "appointment"),
        eq(schema.accessTokens.subjectId, input.appointmentId),
        isNull(schema.accessTokens.revokedAt),
      ),
    );

  const raw = randomBytes(32).toString("hex");
  await tx.insert(schema.accessTokens).values({
    id: newId("tok"),
    tokenHash: hashToken(raw),
    purpose: "appointment_deposit",
    subjectType: "appointment",
    subjectId: input.appointmentId,
    customerId: input.customerId,
    expiresAt: input.expiresAt,
  });
  return raw;
}

/** Resolves a live deposit link and enforces token → appointment customer ownership. */
export async function resolveAppointmentDepositToken(rawToken: string) {
  if (!TOKEN_PATTERN.test(rawToken)) return null;
  const rows = await db()
    .select({ token: schema.accessTokens, appointment: schema.appointments })
    .from(schema.accessTokens)
    .innerJoin(
      schema.appointments,
      and(
        eq(schema.accessTokens.subjectId, schema.appointments.id),
        eq(schema.accessTokens.customerId, schema.appointments.customerId),
      ),
    )
    .where(
      and(
        eq(schema.accessTokens.tokenHash, hashToken(rawToken)),
        eq(schema.accessTokens.purpose, "appointment_deposit"),
        eq(schema.accessTokens.subjectType, "appointment"),
        gt(schema.accessTokens.expiresAt, new Date()),
        isNull(schema.accessTokens.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function loadDepositMessageContext(appointmentId: string) {
  const [appointment] = await db()
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.id, appointmentId))
    .limit(1);
  if (!appointment) return null;
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
  if (!customer) return null;
  return { appointment, customer, vehicle, lines, settings };
}

function messageDestination(customer: { preferredContact: string; email: string | null; phone: string | null }) {
  if (customer.preferredContact === "email" && customer.email) {
    return { channel: "email" as const, to: customer.email };
  }
  if (customer.phone) return { channel: "sms" as const, to: customer.phone };
  if (customer.email) return { channel: "email" as const, to: customer.email };
  return null;
}

/** Sends a truthful pre-payment notice: the slot is held, not confirmed. */
export async function sendAppointmentDepositRequest(
  appointmentId: string,
  depositUrl: string,
): Promise<{ sent: boolean; channel?: "email" | "sms" }> {
  const context = await loadDepositMessageContext(appointmentId);
  if (!context) return { sent: false };
  const { appointment, customer, vehicle, lines, settings } = context;
  const destination = messageDestination(customer);
  if (!destination) return { sent: false };
  const when = formatInZone(appointment.startsAt, settings.timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const result = await sendMessage({
    customerId: customer.id,
    channel: destination.channel,
    kind: "deposit_reminder",
    to: destination.to,
    subject: destination.channel === "email" ? `Deposit required — ${settings.businessName}` : undefined,
    body: [
      `Hi ${customer.firstName},`,
      "",
      `We are holding ${when} for your ${[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "vehicle"}.`,
      `Services: ${lines.map((line) => line.description).join(", ")}.`,
      `Your appointment is not confirmed until the ${formatCents(appointment.depositRequiredCents, settings.currency)} deposit is paid.`,
      `Pay securely: ${depositUrl}`,
      "",
      `Estimated total: ${formatCents(appointment.totalCents, settings.currency)}.`,
      `— ${settings.businessName}`,
    ].join("\n"),
    relatedEntityType: "appointment",
    relatedEntityId: appointment.id,
  });
  return { sent: result.sent, channel: destination.channel };
}

/** Sends one post-payment receipt that also clearly confirms the appointment. */
export async function sendAppointmentDepositConfirmation(
  appointmentId: string,
  amountCents: number,
): Promise<void> {
  const context = await loadDepositMessageContext(appointmentId);
  if (!context) return;
  const { appointment, customer, vehicle, settings } = context;
  const destination = messageDestination(customer);
  if (!destination) return;
  const when = formatInZone(appointment.startsAt, settings.timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const balance = Math.max(0, appointment.totalCents - appointment.depositPaidCents);
  await sendMessage({
    customerId: customer.id,
    channel: destination.channel,
    kind: "confirmation",
    to: destination.to,
    subject: destination.channel === "email" ? `Deposit received — booking confirmed` : undefined,
    body: [
      `Hi ${customer.firstName},`,
      "",
      `We received your deposit of ${formatCents(amountCents, settings.currency)}. Your appointment is now confirmed for ${when}.`,
      `Vehicle: ${[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Vehicle on file"}.`,
      `Estimated balance after deposit: ${formatCents(balance, settings.currency)}.`,
      "",
      `Payment reference: ${appointment.id}`,
      `— ${settings.businessName}`,
    ].join("\n"),
    relatedEntityType: "appointment",
    relatedEntityId: appointment.id,
  });
}
