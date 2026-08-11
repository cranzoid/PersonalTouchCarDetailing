"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import { formatCents, percentCents } from "@/lib/money";
import {
  buildConsolidatedInvoiceLines,
  computeInvoiceTotals,
  createInvoiceAccessToken,
  nextInvoiceNumber,
  recalculateInvoiceStatus,
  sendInvoiceReceipt,
  summarizePayments,
} from "@/lib/invoices";
import { zonedToUtc } from "@/lib/tz";
import { resolveCatalogPrices } from "@/lib/pricing";
import { MANUAL_PAYMENT_METHODS, VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import { getAppBaseUrl } from "@/lib/urls";
import {
  decodeStripeRefundReference,
  encodeStripeRefundReference,
  finalizeStripeRefund,
  getPaymentProvider,
  getRefundAvailability,
} from "@/lib/payments";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Create invoice from a job                                           */
/* ------------------------------------------------------------------ */

export async function createInvoiceFromJobAction(
  raw: unknown,
): Promise<ActionResult<{ invoiceId: string }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z.object({ jobId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { jobId } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ invoiceId: string }>> => {
      const rows = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update");
      const job = rows[0];
      if (!job) return { ok: false, error: "Job not found" };
      if (job.invoiceId) return { ok: false, error: "This job already has an invoice" };
      if (!["ready_for_pickup", "completed"].includes(job.status)) {
        return { ok: false, error: "The job must be ready for pickup or completed before invoicing" };
      }

      const appointment = job.appointmentId
        ? (await tx.select().from(schema.appointments).where(eq(schema.appointments.id, job.appointmentId)).limit(1))[0]
        : undefined;
      const appointmentLines = appointment
        ? await tx
            .select()
            .from(schema.appointmentServices)
            .where(eq(schema.appointmentServices.appointmentId, appointment.id))
        : [];
      const approvedWork = await tx
        .select()
        .from(schema.additionalWorkRequests)
        .where(eq(schema.additionalWorkRequests.jobId, jobId));
      const billableWork = approvedWork.filter((r) => r.status === "approved" || r.status === "override_approved");

      const lines = [
        ...appointmentLines.map((l) => ({
          serviceId: l.serviceId,
          description: l.description,
          quantity: 1,
          unitPriceCents: l.priceCents,
        })),
        ...billableWork.map((r) => ({
          serviceId: null as string | null,
          description: r.description,
          quantity: 1,
          unitPriceCents: r.priceCents,
        })),
      ];
      if (lines.length === 0) {
        return { ok: false, error: "Nothing to invoice — no booked services or approved additional work" };
      }

      // `??` not `||`: a legitimately zero-rated appointment (0) must stay zero.
      // With `||` it silently fell back to the 13% settings rate, which made
      // tax exemption impossible on job-derived invoices.
      const taxRateBp = appointment?.taxRateBp ?? settings.taxRateBp;
      // The promotional discount locked when the customer booked. Carried
      // across as a fixed amount, never recalculated: additional work approved
      // at the shop is billed at full price, and computeInvoiceTotals clamps it
      // to the subtotal.
      const discountCents = appointment?.discountCents ?? 0;
      const totals = computeInvoiceTotals(lines, discountCents, taxRateBp);
      const depositAppliedCents = Math.min(appointment?.depositPaidCents ?? 0, totals.totalCents);

      const number = await nextInvoiceNumber(tx);
      const invoiceId = newId("inv");
      await tx.insert(schema.invoices).values({
        id: invoiceId,
        number,
        customerId: job.customerId,
        vehicleId: job.vehicleId,
        jobId: job.id,
        status: "draft",
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxRateBp,
        taxLabel: settings.taxLabel,
        taxRegistrationNumber: settings.taxRegistrationNumber || null,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        depositAppliedCents,
        notes: appointment?.promoLabel
          ? `${appointment.promoLabel}${appointment.promoCode ? ` (${appointment.promoCode})` : ""} applied at booking.`
          : null,
      });
      await tx.insert(schema.invoiceLineItems).values(
        lines.map((line, i) => ({
          id: newId("ili"),
          invoiceId,
          serviceId: line.serviceId,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          sort: i,
        })),
      );
      await tx.insert(schema.invoiceJobs).values({ id: newId("ij"), invoiceId, jobId: job.id });
      await tx.update(schema.jobs).set({ invoiceId, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.created",
        entityType: "invoice",
        entityId: invoiceId,
        after: {
          number,
          jobId,
          totalCents: totals.totalCents,
          discountCents: totals.discountCents,
          promoCode: appointment?.promoCode ?? null,
          lines: lines.length,
        },
      });
      return { ok: true, invoiceId };
    });

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/jobs/${jobId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createInvoiceFromJobAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Consolidated fleet invoice                                         */
/* ------------------------------------------------------------------ */

export async function createConsolidatedInvoiceAction(
  raw: unknown,
): Promise<ActionResult<{ invoiceId: string }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z.object({
      customerId: z.string().min(1),
      jobIds: z.array(z.string().min(1)).min(1).max(50),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Select at least one valid job" };
    const { customerId, jobIds } = parsed.data;
    if (new Set(jobIds).size !== jobIds.length) return { ok: false, error: "A job was selected more than once" };
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ invoiceId: string }>> => {
      const [customer] = await tx.select().from(schema.customers)
        .where(eq(schema.customers.id, customerId)).for("update");
      if (!customer) return { ok: false, error: "Customer not found" };
      if (customer.customerType !== "business") {
        return { ok: false, error: "Consolidated invoices are available only for business customers" };
      }

      const selectedRows = await tx.select().from(schema.jobs)
        .where(inArray(schema.jobs.id, jobIds)).for("update");
      if (selectedRows.length !== jobIds.length) return { ok: false, error: "One or more jobs could not be found" };
      const jobsById = new Map(selectedRows.map((job) => [job.id, job]));
      const selectedJobs = jobIds.map((id) => jobsById.get(id)!);
      if (selectedJobs.some((job) => job.customerId !== customerId)) {
        return { ok: false, error: "All jobs must belong to the same business customer" };
      }
      if (selectedJobs.some((job) => !["ready_for_pickup", "completed"].includes(job.status))) {
        return { ok: false, error: "Every job must be ready for pickup or completed" };
      }
      if (selectedJobs.some((job) => job.invoiceId)) {
        return { ok: false, error: "One or more selected jobs already has an invoice" };
      }
      const existingLinks = await tx.select({ jobId: schema.invoiceJobs.jobId })
        .from(schema.invoiceJobs).where(inArray(schema.invoiceJobs.jobId, jobIds)).for("update");
      if (existingLinks.length > 0) return { ok: false, error: "One or more selected jobs is already invoiced" };

      const appointmentRefs = selectedJobs.flatMap((job) => job.appointmentId ? [job.appointmentId] : []);
      const appointmentIds = [...new Set(appointmentRefs)];
      if (appointmentIds.length !== appointmentRefs.length) {
        return { ok: false, error: "Selected jobs contain a duplicate appointment and cannot be billed together" };
      }
      const appointmentRows = appointmentIds.length > 0
        ? await tx.select().from(schema.appointments).where(inArray(schema.appointments.id, appointmentIds))
        : [];
      if (
        appointmentRows.length !== appointmentIds.length ||
        appointmentRows.some((appointment) => appointment.customerId !== customerId)
      ) {
        return { ok: false, error: "One or more jobs has an invalid appointment relationship" };
      }
      const appointmentLines = appointmentIds.length > 0
        ? await tx.select().from(schema.appointmentServices)
            .where(inArray(schema.appointmentServices.appointmentId, appointmentIds))
        : [];
      const linesByAppointment = new Map<string, typeof appointmentLines>();
      for (const line of appointmentLines) {
        const bucket = linesByAppointment.get(line.appointmentId) ?? [];
        bucket.push(line);
        linesByAppointment.set(line.appointmentId, bucket);
      }
      const workRows = await tx.select().from(schema.additionalWorkRequests)
        .where(inArray(schema.additionalWorkRequests.jobId, jobIds));
      const approvedWorkByJob = new Map<string, typeof workRows>();
      for (const work of workRows.filter((row) => ["approved", "override_approved"].includes(row.status))) {
        const bucket = approvedWorkByJob.get(work.jobId) ?? [];
        bucket.push(work);
        approvedWorkByJob.set(work.jobId, bucket);
      }
      const vehicleIds = [...new Set(selectedJobs.map((job) => job.vehicleId))];
      const vehicleRows = await tx.select().from(schema.vehicles).where(inArray(schema.vehicles.id, vehicleIds));
      if (
        vehicleRows.length !== vehicleIds.length ||
        vehicleRows.some((vehicle) => vehicle.customerId !== customerId)
      ) {
        return { ok: false, error: "One or more jobs has an invalid vehicle relationship" };
      }
      const vehiclesById = new Map(vehicleRows.map((vehicle) => [vehicle.id, vehicle]));

      const sources = selectedJobs.map((job) => {
        const vehicle = vehiclesById.get(job.vehicleId);
        const vehicleLabel = vehicle
          ? [vehicle.year, vehicle.make, vehicle.model, vehicle.licencePlate && `(${vehicle.licencePlate})`].filter(Boolean).join(" ")
          : `Vehicle for job ${job.id}`;
        return {
          jobId: job.id,
          vehicleLabel,
          appointmentLines: job.appointmentId
            ? (linesByAppointment.get(job.appointmentId) ?? []).map((line) => ({
                serviceId: line.serviceId,
                description: line.description,
                priceCents: line.priceCents,
              }))
            : [],
          approvedAdditionalWork: (approvedWorkByJob.get(job.id) ?? []).map((work) => ({
            description: work.description,
            priceCents: work.priceCents,
          })),
        };
      });
      const lines = buildConsolidatedInvoiceLines(sources);
      if (lines.length === 0) {
        return { ok: false, error: "Nothing to invoice — selected jobs have no booked services or approved work" };
      }

      const taxRates = new Set(appointmentRows.map((appointment) => appointment.taxRateBp));
      if (taxRates.size > 1) {
        return { ok: false, error: "Selected jobs use different tax rates and cannot share one invoice" };
      }
      const taxRateBp = taxRates.values().next().value ?? settings.taxRateBp;
      // Each appointment's locked discount rides with its own lines. Normally
      // zero here — a first-time offer and a fleet account rarely meet — but
      // the invoice must not silently drop the money when they do.
      const discountCents = appointmentRows.reduce(
        (sum, appointment) => sum + appointment.discountCents,
        0,
      );
      const totals = computeInvoiceTotals(lines, discountCents, taxRateBp);
      const deposits = appointmentRows.reduce((sum, appointment) => sum + appointment.depositPaidCents, 0);
      const depositAppliedCents = Math.min(deposits, totals.totalCents);
      const number = await nextInvoiceNumber(tx);
      const invoiceId = newId("inv");

      await tx.insert(schema.invoices).values({
        id: invoiceId,
        number,
        customerId,
        vehicleId: null,
        jobId: null,
        status: "draft",
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxRateBp,
        taxLabel: settings.taxLabel,
        taxRegistrationNumber: settings.taxRegistrationNumber || null,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        depositAppliedCents,
        notes: [
          `Consolidated fleet invoice for ${selectedJobs.length} job${selectedJobs.length === 1 ? "" : "s"}.`,
          ...[...new Set(appointmentRows.map((a) => a.promoLabel).filter(Boolean))].map(
            (label) => `${label} applied at booking.`,
          ),
        ].join(" "),
      });
      await tx.insert(schema.invoiceLineItems).values(lines.map((line, sort) => ({
        id: newId("ili"),
        invoiceId,
        serviceId: line.serviceId,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        sort,
      })));
      await tx.insert(schema.invoiceJobs).values(selectedJobs.map((job) => ({
        id: newId("ij"),
        invoiceId,
        jobId: job.id,
      })));
      await tx.update(schema.jobs).set({ invoiceId, updatedAt: new Date() })
        .where(and(inArray(schema.jobs.id, jobIds), eq(schema.jobs.customerId, customerId)));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.created_consolidated",
        entityType: "invoice",
        entityId: invoiceId,
        after: { number, customerId, jobIds, totalCents: totals.totalCents, lines: lines.length },
      });
      return { ok: true, invoiceId };
    });

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/fleet/${customerId}`);
      for (const jobId of jobIds) revalidatePath(`/admin/jobs/${jobId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createConsolidatedInvoiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export async function sendInvoiceAction(
  raw: unknown,
): Promise<ActionResult<{ link: string; delivery: "email" | "sms" | null }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z.object({ invoiceId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { invoiceId } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<
      | { ok: false; error: string }
      | { ok: true; token: string; invoice: typeof schema.invoices.$inferSelect }
    > => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      if (!["draft", "sent", "partially_paid", "overdue"].includes(invoice.status)) {
        return { ok: false, error: `A ${invoice.status.replaceAll("_", " ")} invoice cannot be sent` };
      }
      const token = await createInvoiceAccessToken(tx, {
        invoiceId,
        customerId: invoice.customerId,
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      });
      await tx
        .update(schema.invoices)
        .set({
          status: invoice.status === "draft" ? "sent" : invoice.status,
          sentAt: invoice.sentAt ?? new Date(),
          dueAt: invoice.dueAt ?? new Date(Date.now() + 14 * 86_400_000),
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, invoiceId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.sent",
        entityType: "invoice",
        entityId: invoiceId,
        before: { status: invoice.status },
        after: { status: invoice.status === "draft" ? "sent" : invoice.status },
      });
      return { ok: true, token, invoice };
    });
    if (!result.ok) return { ok: false, error: result.error };

    const base = getAppBaseUrl();
    const link = `${base}/portal/invoices/${result.token}`;

    const customer = (
      await db().select().from(schema.customers).where(eq(schema.customers.id, result.invoice.customerId)).limit(1)
    )[0];
    const message = customer
      ? await sendMessageTemplate({
          templateKey: "invoice_sent",
          recipient: customer,
          customerId: customer.id,
          kind: "invoice",
          variables: {
            businessName: settings.businessName,
            firstName: customer.firstName,
            invoiceNumber: String(result.invoice.number),
            total: formatCents(result.invoice.totalCents, settings.currency),
            link,
          },
          relatedEntityType: "invoice",
          relatedEntityId: invoiceId,
        })
      : null;

    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/admin/invoices");
    return { ok: true, link, delivery: message?.sent ? (message.channel ?? null) : null };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendInvoiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Manual payments (cash / e-transfer / card terminal)                 */
/* ------------------------------------------------------------------ */

const NOT_PAYABLE_STATUSES = new Set(["cancelled", "refunded"]);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/);

export async function recordPaymentAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("record_payments");
    const parsed = z
      .object({
        invoiceId: z.string().min(1),
        method: z.enum(MANUAL_PAYMENT_METHODS),
        amountCents: z.number().int().min(1).max(10_000_000),
        idempotencyKey: idempotencyKeySchema,
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the payment fields" };
    const input = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ newlyRecorded: boolean }>> => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };

      const existing = (
        await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.idempotencyKey, input.idempotencyKey))
          .limit(1)
      )[0];
      if (existing) {
        const sameOperation =
          existing.invoiceId === invoice.id &&
          existing.appointmentId === null &&
          existing.customerId === invoice.customerId &&
          existing.kind === "payment" &&
          existing.provider === input.method &&
          existing.amountCents === input.amountCents &&
          existing.status === "succeeded";
        return sameOperation
          ? { ok: true, newlyRecorded: false }
          : { ok: false, error: "That idempotency key was already used for a different payment" };
      }
      if (NOT_PAYABLE_STATUSES.has(invoice.status) || invoice.status === "paid") {
        return { ok: false, error: `A ${invoice.status.replaceAll("_", " ")} invoice cannot take a payment` };
      }
      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, input.invoiceId));
      const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
      if (input.amountCents > summary.balanceCents) {
        return { ok: false, error: `Amount exceeds the balance due (${formatCents(summary.balanceCents, settings.currency)})` };
      }

      await tx.insert(schema.payments).values({
        id: newId("pay"),
        invoiceId: input.invoiceId,
        customerId: invoice.customerId,
        provider: input.method,
        idempotencyKey: input.idempotencyKey,
        kind: "payment",
        amountCents: input.amountCents,
        status: "succeeded",
        receivedAt: new Date(),
        recordedByStaffId: staff.id,
      });

      const { status } = await recalculateInvoiceStatus(tx, input.invoiceId);

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.payment_recorded",
        entityType: "invoice",
        entityId: input.invoiceId,
        after: { method: input.method, amountCents: input.amountCents, status },
      });
      return { ok: true, newlyRecorded: true };
    });
    if (!result.ok) return result;

    if (result.newlyRecorded) {
      try {
        await sendInvoiceReceipt(input.invoiceId, input.amountCents);
      } catch (err) {
        // The financial transaction is already committed. Receipt delivery is
        // best-effort and must never make a successful payment look failed to
        // staff, which could prompt a duplicate retry.
        console.error("payment recorded but receipt delivery failed", err);
      }
    }

    revalidatePath(`/admin/invoices/${input.invoiceId}`);
    revalidatePath("/admin/invoices");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("recordPaymentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

export async function issueRefundAction(
  raw: unknown,
): Promise<ActionResult<{ status: "pending" | "succeeded" }>> {
  try {
    const staff = await requireStaff("issue_refunds");
    const parsed = z
      .object({
        invoiceId: z.string().min(1),
        amountCents: z.number().int().min(1).max(10_000_000),
        reason: z.string().trim().min(1).max(1000),
        idempotencyKey: idempotencyKeySchema,
        method: z.enum(["stripe", ...MANUAL_PAYMENT_METHODS]).default("cash"),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason and amount are required" };
    const input = parsed.data;
    const settings = await getSettings();

    const prepared = await db().transaction(async (tx): Promise<
      | { ok: false; error: string }
      | { ok: true; status: "succeeded"; route: "manual" }
      | {
          ok: true;
          status: "pending";
          route: "stripe";
          refundPaymentId: string;
          amountCents: number;
          checkoutSessionId: string;
          invoiceId: string;
        }
    > => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };

      const existing = (
        await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.idempotencyKey, input.idempotencyKey))
          .limit(1)
      )[0];
      if (existing) {
        const sameOperation =
          existing.invoiceId === invoice.id &&
          existing.appointmentId === null &&
          existing.customerId === invoice.customerId &&
          existing.kind === "refund" &&
          existing.provider === input.method &&
          existing.amountCents === input.amountCents;
        if (!sameOperation) return { ok: false, error: "That idempotency key was already used for a different refund" };
        if (existing.status === "succeeded") return { ok: true, status: "succeeded", route: "manual" };
        if (input.method !== "stripe" || existing.status !== "pending") {
          return { ok: false, error: "That refund attempt failed; submit a new refund request" };
        }
        const reference = decodeStripeRefundReference(existing.providerRef);
        if (!reference) return { ok: false, error: "The pending Stripe refund has invalid provider data" };
        return {
          ok: true,
          status: "pending",
          route: "stripe",
          refundPaymentId: existing.id,
          amountCents: existing.amountCents,
          checkoutSessionId: reference.checkoutSessionId,
          invoiceId: invoice.id,
        };
      }
      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, input.invoiceId));
      const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
      const pendingRefundCents = payments
        .filter((payment) => payment.kind === "refund" && payment.status === "pending")
        .reduce((sum, payment) => sum + payment.amountCents, 0);
      const availableCents = Math.max(0, summary.netPaidCents - pendingRefundCents);
      if (input.amountCents > availableCents) {
        return { ok: false, error: `Refund exceeds the unreserved amount paid (${formatCents(availableCents, settings.currency)})` };
      }

      const availability = getRefundAvailability(payments, invoice.depositAppliedCents);
      if (input.method === "stripe") {
        if (input.amountCents > availability.stripeRefundableCents) {
          return {
            ok: false,
            error: `Only ${formatCents(availability.stripeRefundableCents, settings.currency)} remains refundable through Stripe`,
          };
        }
        const source = availability.stripeSources.find((candidate) => candidate.refundableCents >= input.amountCents);
        if (!source) {
          const largest = Math.max(0, ...availability.stripeSources.map((candidate) => candidate.refundableCents));
          return {
            ok: false,
            error: `Stripe funds are split across charges; refund at most ${formatCents(largest, settings.currency)} per request`,
          };
        }
        const refundPaymentId = newId("pay");
        await tx.insert(schema.payments).values({
          id: refundPaymentId,
          invoiceId: input.invoiceId,
          customerId: invoice.customerId,
          provider: "stripe",
          providerRef: encodeStripeRefundReference({
            sourcePaymentId: source.paymentId,
            checkoutSessionId: source.checkoutSessionId,
          }),
          idempotencyKey: input.idempotencyKey,
          kind: "refund",
          amountCents: input.amountCents,
          status: "pending",
          recordedByStaffId: staff.id,
        });
        await audit(tx, {
          actorType: "staff",
          actorId: staff.id,
          action: "invoice.refund_requested",
          entityType: "invoice",
          entityId: input.invoiceId,
          after: { refundPaymentId, amountCents: input.amountCents, provider: "stripe" },
          reason: input.reason,
        });
        return {
          ok: true,
          status: "pending",
          route: "stripe",
          refundPaymentId,
          amountCents: input.amountCents,
          checkoutSessionId: source.checkoutSessionId,
          invoiceId: invoice.id,
        };
      }

      if (input.amountCents > availability.manualRefundableCents) {
        return {
          ok: false,
          error: `Only ${formatCents(availability.manualRefundableCents, settings.currency)} remains for a manually issued refund`,
        };
      }
      await tx.insert(schema.payments).values({
        id: newId("pay"),
        invoiceId: input.invoiceId,
        customerId: invoice.customerId,
        provider: input.method,
        idempotencyKey: input.idempotencyKey,
        kind: "refund",
        amountCents: input.amountCents,
        status: "succeeded",
        receivedAt: new Date(),
        recordedByStaffId: staff.id,
      });
      const { status } = await recalculateInvoiceStatus(tx, input.invoiceId);
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.refunded",
        entityType: "invoice",
        entityId: input.invoiceId,
        after: { method: input.method, amountCents: input.amountCents, status },
        reason: input.reason,
      });
      return { ok: true, status: "succeeded", route: "manual" };
    });

    if (!prepared.ok) return prepared;
    if (prepared.route === "manual") {
      revalidatePath(`/admin/invoices/${input.invoiceId}`);
      revalidatePath("/admin/invoices");
      return { ok: true, status: "succeeded" };
    }

    let provider;
    try {
      provider = getPaymentProvider();
    } catch {
      return { ok: false, error: "Stripe refunds are unavailable because the payment provider is not configured" };
    }
    if (provider.name !== "stripe") {
      return { ok: false, error: "Stripe refunds are unavailable in the development payment provider" };
    }

    let providerResult;
    try {
      providerResult = await provider.refundPayment({
        checkoutSessionId: prepared.checkoutSessionId,
        amountCents: prepared.amountCents,
        refundPaymentId: prepared.refundPaymentId,
        invoiceId: prepared.invoiceId,
        idempotencyKey: `stripe_refund_${prepared.refundPaymentId}`,
      });
    } catch {
      // Keep the row pending. Retrying the same staff request reuses both the
      // local row and Stripe idempotency key, so an ambiguous network failure
      // cannot produce a second refund.
      return { ok: false, error: "Stripe could not confirm the refund. Retry the same request safely." };
    }

    const finalized = await db().transaction((tx) =>
      finalizeStripeRefund(tx, {
        refundPaymentId: prepared.refundPaymentId,
        providerRef: providerResult.providerRef,
        amountCents: providerResult.amountCents,
        providerStatus: providerResult.status,
      }),
    );
    if (!finalized) return { ok: false, error: "Stripe returned refund details that did not match the ledger reservation" };
    revalidatePath(`/admin/invoices/${input.invoiceId}`);
    revalidatePath("/admin/invoices");
    if (finalized.status === "failed") return { ok: false, error: "Stripe declined the refund" };
    return { ok: true, status: finalized.status };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("issueRefundAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Cancel                                                               */
/* ------------------------------------------------------------------ */

export async function cancelInvoiceAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z
      .object({ invoiceId: z.string().min(1), reason: z.string().trim().min(1).max(1000) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason is required to cancel an invoice" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      if (!["draft", "sent", "overdue"].includes(invoice.status)) {
        return { ok: false, error: `A ${invoice.status.replaceAll("_", " ")} invoice cannot be cancelled — issue a refund instead` };
      }
      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, input.invoiceId));
      const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
      if (summary.netPaidCents > 0) {
        return { ok: false, error: "This invoice has payments recorded — refund instead of cancelling" };
      }

      await tx
        .update(schema.invoices)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledByStaffId: staff.id,
          cancellationReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, input.invoiceId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.cancelled",
        entityType: "invoice",
        entityId: input.invoiceId,
        before: { status: invoice.status },
        after: { status: "cancelled" },
        reason: input.reason,
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath(`/admin/invoices/${input.invoiceId}`);
      revalidatePath("/admin/invoices");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("cancelInvoiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Manual invoice (walk-ins, work already done)                        */
/* ------------------------------------------------------------------ */

/** "YYYY-MM-DD" business-local -> the UTC instant at local noon that day. */
function localNoonUtc(timeZone: string, dateISO: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  return zonedToUtc(timeZone, y, m, d, 12, 0);
}

/**
 * Catalog lines carry an id, not a price: the server looks the price up and
 * applies the vehicle-size adjustment, so the client cannot understate a
 * package. `unitPriceCents` is an explicit staff override — needed for
 * quote-only services and one-off adjustments, and recorded on the line.
 */
const manualLineInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("service"),
    serviceId: z.string().min(1),
    quantity: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("addon"),
    addonId: z.string().min(1),
    quantity: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal("custom"),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0),
  }),
]);

const createManualInvoiceInput = z.object({
  customerId: z.string().min(1),
  vehicleId: z.string().min(1).optional(),
  lines: z.array(manualLineInput).min(1).max(50),
  discountCents: z.number().int().min(0).default(0),
  /** Alternative to discountCents: basis points off the subtotal (500 = 5%). */
  discountPercentBp: z.number().int().min(0).max(10000).optional(),
  /** Business-local calendar date; may be in the past for work already done. */
  invoiceDateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxExempt: z.boolean().default(false),
  taxExemptReason: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * Raises an invoice that has no originating job — a walk-in, a cash job, or
 * work completed before the customer existed in the system.
 *
 * Reuses computeInvoiceTotals / nextInvoiceNumber so numbering and money math
 * are identical to job-derived invoices. `invoices.jobId` stays null and no
 * invoice_jobs row is written, which keeps the one-invoice-per-job constraint
 * untouched.
 */
export async function createManualInvoiceAction(
  raw: unknown,
): Promise<ActionResult<{ invoiceId: string }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = createManualInvoiceInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the invoice details" };
    const input = parsed.data;
    if (input.taxExempt && !input.taxExemptReason) {
      return { ok: false, error: "Give a reason for not charging tax — it appears on the invoice and the tax report" };
    }

    const settings = await getSettings();
    // Exempt invoices snapshot a 0 rate so the stored document stays
    // self-describing; the flag and reason record WHY it was zero.
    const taxRateBp = input.taxExempt ? 0 : settings.taxRateBp;

    // Vehicle size drives package pricing, so resolve it before costing lines.
    let vehicleCategory: VehicleCategory | null = null;
    if (input.vehicleId) {
      const [vehicle] = await db()
        .select({ customerId: schema.vehicles.customerId, category: schema.vehicles.category })
        .from(schema.vehicles)
        .where(eq(schema.vehicles.id, input.vehicleId))
        .limit(1);
      if (!vehicle || vehicle.customerId !== input.customerId) {
        return { ok: false, error: "That vehicle belongs to a different customer" };
      }
      vehicleCategory = VEHICLE_CATEGORIES.includes(vehicle.category as VehicleCategory)
        ? (vehicle.category as VehicleCategory)
        : null;
    }

    const catalog = await resolveCatalogPrices({
      serviceIds: input.lines.flatMap((l) => (l.kind === "service" ? [l.serviceId] : [])),
      addonIds: input.lines.flatMap((l) => (l.kind === "addon" ? [l.addonId] : [])),
      vehicleCategory,
    });

    const lines: { serviceId: string | null; description: string; quantity: number; unitPriceCents: number }[] = [];
    for (const line of input.lines) {
      if (line.kind === "custom") {
        lines.push({
          serviceId: null,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        });
        continue;
      }
      const entry =
        line.kind === "service" ? catalog.services.get(line.serviceId) : catalog.addons.get(line.addonId);
      if (!entry) return { ok: false, error: "A selected service or add-on no longer exists" };
      if (entry.requiresManualPrice && line.unitPriceCents === undefined) {
        return { ok: false, error: `"${entry.description}" is quote-only — enter a price for it` };
      }
      lines.push({
        // Only real services carry a serviceId; add-ons are their own table and
        // the column is a services FK, so they record as descriptive lines.
        serviceId: line.kind === "service" ? line.serviceId : null,
        description: entry.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents ?? entry.priceCents,
      });
    }

    // Percentage discounts are computed against the resolved subtotal so the
    // client never decides the amount.
    const subtotalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
    const discountCents =
      input.discountPercentBp !== undefined
        ? percentCents(subtotalCents, input.discountPercentBp)
        : input.discountCents;
    const totals = computeInvoiceTotals(lines, discountCents, taxRateBp);

    const result = await db().transaction(async (tx): Promise<ActionResult<{ invoiceId: string }>> => {
      const [customer] = await tx
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, input.customerId))
        .limit(1);
      if (!customer || customer.anonymizedAt) return { ok: false, error: "Customer not found" };

      const number = await nextInvoiceNumber(tx);
      const invoiceId = newId("inv");
      await tx.insert(schema.invoices).values({
        id: invoiceId,
        number,
        customerId: input.customerId,
        vehicleId: input.vehicleId,
        jobId: null,
        status: "draft",
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxRateBp,
        taxLabel: settings.taxLabel,
        taxRegistrationNumber: settings.taxRegistrationNumber || null,
        taxCents: totals.taxCents,
        taxExempt: input.taxExempt,
        taxExemptReason: input.taxExempt ? input.taxExemptReason : null,
        totalCents: totals.totalCents,
        // Noon business-local, matching zonedWeekday's DST-safe convention, so
        // a backdated invoice lands on the intended calendar day everywhere.
        invoiceDate: input.invoiceDateISO ? localNoonUtc(settings.timezone, input.invoiceDateISO) : new Date(),
        createdByStaffId: staff.id,
        notes: input.notes,
      });
      await tx.insert(schema.invoiceLineItems).values(
        lines.map((line, i) => ({
          id: newId("ili"),
          invoiceId,
          serviceId: line.serviceId,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          sort: i,
        })),
      );
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.created_manually",
        entityType: "invoice",
        entityId: invoiceId,
        after: {
          number,
          customerId: input.customerId,
          totalCents: totals.totalCents,
          lines: lines.length,
          taxExempt: input.taxExempt,
          backdated: Boolean(input.invoiceDateISO),
        },
        reason: input.taxExempt ? input.taxExemptReason : undefined,
      });
      return { ok: true, invoiceId };
    });

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/invoices/${result.invoiceId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createManualInvoiceAction failed", err);
    return { ok: false, error: "Something went wrong creating the invoice" };
  }
}

/**
 * Switches an existing invoice between taxed and exempt, recomputing the total
 * from the stored line items.
 *
 * Restricted to invoices with no money against them: totals are an immutable
 * snapshot once a payment exists, and rewriting them would desynchronise the
 * payment ledger from the balance owed.
 */
export async function setInvoiceTaxExemptAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z
      .object({
        invoiceId: z.string().min(1),
        taxExempt: z.boolean(),
        reason: z.string().trim().max(200).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const input = parsed.data;
    if (input.taxExempt && !input.reason) {
      return { ok: false, error: "Give a reason for not charging tax" };
    }

    const settings = await getSettings();
    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      if (!["draft", "sent", "overdue"].includes(invoice.status)) {
        return { ok: false, error: `A ${invoice.status.replaceAll("_", " ")} invoice cannot have its tax changed` };
      }

      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      if (payments.some((p) => p.status === "succeeded")) {
        return { ok: false, error: "This invoice already has a payment — cancel it and raise a new one instead" };
      }

      const lines = await tx
        .select()
        .from(schema.invoiceLineItems)
        .where(eq(schema.invoiceLineItems.invoiceId, invoice.id));
      const taxRateBp = input.taxExempt ? 0 : settings.taxRateBp;
      const totals = computeInvoiceTotals(lines, invoice.discountCents, taxRateBp);

      await tx
        .update(schema.invoices)
        .set({
          taxRateBp,
          taxCents: totals.taxCents,
          taxExempt: input.taxExempt,
          taxExemptReason: input.taxExempt ? input.reason : null,
          totalCents: totals.totalCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, invoice.id));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.tax_exemption_changed",
        entityType: "invoice",
        entityId: invoice.id,
        before: { taxExempt: invoice.taxExempt, taxRateBp: invoice.taxRateBp, totalCents: invoice.totalCents },
        after: { taxExempt: input.taxExempt, taxRateBp, totalCents: totals.totalCents },
        reason: input.reason,
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/invoices/${input.invoiceId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("setInvoiceTaxExemptAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
