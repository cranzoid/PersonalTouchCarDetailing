"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { isMaintenanceReminderDue } from "@/lib/scheduling";
import { sendMessageTemplate } from "@/lib/messaging";
import { parseCcList } from "@/lib/email";
import { formatCents, percentCents } from "@/lib/money";
import {
  buildConsolidatedInvoiceLines,
  computeInvoiceTotals,
  createInvoiceAccessToken,
  nextInvoiceNumber,
  recalculateInvoiceStatus,
  resolvePaymentTax,
  sendInvoiceReceipt,
  summarizePayments,
  tipCentsFromBasisPoints,
} from "@/lib/invoices";
import { zonedToUtc } from "@/lib/tz";
import { resolveCatalogPrices } from "@/lib/pricing";
import {
  MANUAL_PAYMENT_METHODS,
  MAX_TIP_BP,
  VEHICLE_CATEGORIES,
  type ManualPaymentMethod,
  type VehicleCategory,
} from "@/lib/types";
import { getAppBaseUrl } from "@/lib/urls";
import {
  closeCheckout,
  decodeHelcimRefundReference,
  encodeHelcimRefundReference,
  executeCardRefund,
  getRefundAvailability,
  reconcileCheckout,
  startInvoiceTerminalCheckout,
} from "@/lib/payments";
import { fromHelcimAmount } from "@/lib/helcim/client";
import { requestIp } from "@/lib/request-ip";
import { createCustomerPortalToken } from "@/lib/portal";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Create invoice from a job                                           */
/* ------------------------------------------------------------------ */

/** Transaction handle, as handed to the callback by `db().transaction`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Builds the invoice for an already-locked job: the booked appointment lines
 * plus any approved additional work, carrying the booking's discount, promo
 * provenance, tax rate and deposit.
 *
 * Shared by the two ways a visit reaches an invoice — the job screen, and a
 * completed appointment that was never checked in. Extracted so the money
 * logic has exactly one home: a second copy is precisely the kind of drift
 * that silently re-bills a discounted booking at full price.
 *
 * The caller owns the transaction and must already hold `job` FOR UPDATE.
 */
async function buildInvoiceForJob(
  tx: Tx,
  input: {
    job: typeof schema.jobs.$inferSelect;
    staffId: string;
    settings: Awaited<ReturnType<typeof getSettings>>;
    /** Which entry point raised this, so the audit row stays legible. */
    source: "job" | "appointment";
  },
): Promise<ActionResult<{ invoiceId: string }>> {
  const { job, settings } = input;

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
    .where(eq(schema.additionalWorkRequests.jobId, job.id));
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
  // The invoice is raised WITH tax, because the shop does not yet know how
  // the customer will pay. Cash or e-transfer strips it when the payment is
  // recorded — see resolvePaymentTax and DECISIONS.md #18.
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
    // The discount rode across from the booking, so its reason is the promo
    // that produced it rather than something staff type here.
    discountReason:
      totals.discountCents > 0
        ? (appointment?.promoLabel ?? "Discount locked at booking")
        : null,
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
  await tx.update(schema.jobs).set({ invoiceId, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));

  await audit(tx, {
    actorType: "staff",
    actorId: input.staffId,
    action: "invoice.created",
    entityType: "invoice",
    entityId: invoiceId,
    after: {
      number,
      jobId: job.id,
      appointmentId: job.appointmentId,
      source: input.source,
      totalCents: totals.totalCents,
      discountCents: totals.discountCents,
      promoCode: appointment?.promoCode ?? null,
      lines: lines.length,
    },
  });
  return { ok: true, invoiceId };
}

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
      return buildInvoiceForJob(tx, { job, staffId: staff.id, settings, source: "job" });
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
/* Create invoice from a completed appointment                         */
/* ------------------------------------------------------------------ */

/**
 * Raises the invoice for a visit that ended without ever being checked in.
 *
 * The shop has two ways to finish a car. Checking it in creates a job, and the
 * job screen invoices from it. But "Mark Arrived" then "Mark Completed" creates
 * no job at all — and since an invoice hangs off `jobs`, that path had no way
 * to bill anyone. Staff were pushed into `/admin/invoices/new`, a blank form
 * that drops the deposit, the promo provenance and any link back to the
 * booking.
 *
 * Rather than teach invoices about appointments (a second parent, a second
 * uniqueness rule, and a second copy of the money logic), this materialises the
 * job the visit should have had and then runs the ordinary job path. The car
 * really was detailed, so the job row is not a fiction — it is the record that
 * was never written. Everything downstream that reasons about completed work —
 * the needs-attention queue, the lead funnel, maintenance reminders — starts
 * seeing these visits, which is the point.
 *
 * Deliberately does NOT move the appointment off `completed`, and deliberately
 * asks nothing about tax or payment method: the invoice is raised with tax and
 * the first payment settles it (DECISIONS.md #18). To change what is being
 * billed, re-price the appointment first — see reviseAppointmentLinesAction.
 */
export async function createInvoiceFromAppointmentAction(
  raw: unknown,
): Promise<ActionResult<{ invoiceId: string; jobId: string }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z.object({ appointmentId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { appointmentId } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(
      async (tx): Promise<ActionResult<{ invoiceId: string; jobId: string }>> => {
        const [appointment] = await tx
          .select()
          .from(schema.appointments)
          .where(eq(schema.appointments.id, appointmentId))
          .for("update");
        if (!appointment) return { ok: false, error: "Appointment not found" };
        // Only a finished visit. A checked-in one is `converted` and already
        // has a job screen to invoice from; anything earlier has not happened.
        if (appointment.status !== "completed") {
          return {
            ok: false,
            error: `A ${appointment.status.replaceAll("_", " ")} appointment cannot be invoiced — mark it completed first`,
          };
        }

        // Reuse a job if one somehow exists; only a visit that never went
        // through check-in needs one materialised here.
        let job = appointment.jobId
          ? (await tx.select().from(schema.jobs).where(eq(schema.jobs.id, appointment.jobId)).for("update"))[0]
          : undefined;
        if (job?.invoiceId) return { ok: false, error: "This appointment already has an invoice" };

        if (!job) {
          const jobId = newId("job");
          // The appointment's end, not `now`: maintenance reminders count
          // months from the visit, so stamping this with the moment staff got
          // round to invoicing would push every future reminder late.
          const completedAt = appointment.endsAt;
          // A visit older than the reminder window would otherwise be due the
          // instant this row appears, and the next cron tick would text the
          // customer "time for your next detail?" about a car they brought in
          // months ago. Back-filling old paperwork must not send mail.
          const alreadyPastDue = isMaintenanceReminderDue(
            { status: "completed", completedAt, maintenanceReminderSentAt: null },
            new Date(),
            settings.maintenanceReminderMonths,
          );
          await tx.insert(schema.jobs).values({
            id: jobId,
            appointmentId: appointment.id,
            customerId: appointment.customerId,
            vehicleId: appointment.vehicleId,
            status: "completed",
            assignedStaffId: appointment.assignedStaffId ?? staff.id,
            resourceId: appointment.resourceId,
            completedAt,
            maintenanceReminderSentAt: alreadyPastDue ? new Date() : null,
          });
          await tx
            .update(schema.appointments)
            .set({ jobId, updatedAt: new Date() })
            .where(eq(schema.appointments.id, appointment.id));
          await audit(tx, {
            actorType: "staff",
            actorId: staff.id,
            action: "job.recorded_from_appointment",
            entityType: "job",
            entityId: jobId,
            after: {
              appointmentId: appointment.id,
              completedAt: completedAt.toISOString(),
              maintenanceReminderSuppressed: alreadyPastDue,
            },
          });
          job = (await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update"))[0];
        }
        if (!job) return { ok: false, error: "Could not record the work for this appointment" };

        const built = await buildInvoiceForJob(tx, {
          job,
          staffId: staff.id,
          settings,
          source: "appointment",
        });
        return built.ok ? { ok: true, invoiceId: built.invoiceId, jobId: job.id } : built;
      },
    );

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath("/admin/appointments");
      revalidatePath(`/admin/appointments/${appointmentId}`);
      revalidatePath("/admin/jobs");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createInvoiceFromAppointmentAction failed", err);
    return { ok: false, error: "Something went wrong creating the invoice" };
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
        discountReason: totals.discountCents > 0 ? "Discount locked at booking" : null,
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
        after: {
          number,
          customerId,
          jobIds,
          totalCents: totals.totalCents,
          lines: lines.length,
        },
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
): Promise<ActionResult<{ link: string; delivery: "email" | "sms" | null; cc: string[] }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z
      .object({
        invoiceId: z.string().min(1),
        cc: z.array(z.string()).max(20).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { invoiceId } = parsed.data;
    const settings = await getSettings();

    // The customer is loaded again after the transaction for the send itself;
    // this early read exists only so a CC equal to the primary address can be
    // dropped before anything is written.
    const [ccCustomer] = await db()
      .select({ email: schema.customers.email })
      .from(schema.invoices)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);
    const ccParsed = parseCcList(parsed.data.cc ?? [], ccCustomer?.email);
    if (!ccParsed.ok) return { ok: false, error: ccParsed.error };
    const cc = ccParsed.cc;

    const result = await db().transaction(async (tx): Promise<
      | { ok: false; error: string }
      | { ok: true; token: string; workspace: boolean; invoice: typeof schema.invoices.$inferSelect }
    > => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      if (!["draft", "sent", "partially_paid", "overdue"].includes(invoice.status)) {
        return { ok: false, error: `A ${invoice.status.replaceAll("_", " ")} invoice cannot be sent` };
      }
      // A fleet account gets its whole workspace — every open and paid
      // invoice, pay any selection at once — rather than a link to this one
      // bill. Earlier workspace links keep working (no revoke), because each
      // invoice email carries one and the bookkeeper may use any of them.
      const [owner] = await tx
        .select({ customerType: schema.customers.customerType })
        .from(schema.customers)
        .where(eq(schema.customers.id, invoice.customerId));
      const workspace = owner?.customerType === "business";
      const token = workspace
        ? await createCustomerPortalToken(tx, {
            customerId: invoice.customerId,
            expiresAt: new Date(Date.now() + 180 * 86_400_000),
            revokeExisting: false,
          })
        : await createInvoiceAccessToken(tx, {
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
          // Replaces, never appends: this is who the current send copies, and
          // it is what the receipt will go to when the invoice is paid.
          ccEmails: cc,
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, invoiceId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.sent",
        entityType: "invoice",
        entityId: invoiceId,
        before: { status: invoice.status, cc: invoice.ccEmails },
        after: { status: invoice.status === "draft" ? "sent" : invoice.status, cc },
      });
      return { ok: true, token, workspace, invoice };
    });
    if (!result.ok) return { ok: false, error: result.error };

    const base = getAppBaseUrl();
    const link = result.workspace ? `${base}/portal/${result.token}` : `${base}/portal/invoices/${result.token}`;

    const customer = (
      await db().select().from(schema.customers).where(eq(schema.customers.id, result.invoice.customerId)).limit(1)
    )[0];
    const message = customer
      ? await sendMessageTemplate({
          templateKey: "invoice_sent",
          recipient: customer,
          customerId: customer.id,
          kind: "invoice",
          cc,
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
    const delivery = message?.sent ? (message.channel ?? null) : null;
    // CC only rides on email. Saying so is better than a panel that claims a
    // copy went out when the owner has switched the template to SMS.
    return { ok: true, link, delivery, cc: delivery === "email" ? cc : [] };
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

/** One row of `invoices`, as read inside a payment transaction. */
type InvoiceRow = typeof schema.invoices.$inferSelect;

/**
 * Records one manual payment against an invoice the caller has already locked
 * FOR UPDATE and checked is payable. Shared by the single-invoice form and the
 * fleet bulk payment, so the tax rule and the balance check cannot drift apart.
 *
 * `amountCents: "balance"` pays whatever is owing once this method has settled
 * the tax — cash on a $197.75 invoice records $175.00 — which is what "mark
 * these paid" means when a fleet sends one cheque for a stack of bills.
 */
async function applyManualPayment(
  tx: Tx,
  input: {
    invoice: InvoiceRow;
    method: ManualPaymentMethod;
    amountCents: number | "balance";
    idempotencyKey: string;
    staffId: string;
    taxLabel: string;
    currency: string;
    /** Cheque number or transfer reference, kept on the payment row. */
    reference?: string | null;
    /** Extra context for the payment audit entry (e.g. the bulk batch). */
    auditContext?: Record<string, unknown>;
  },
): Promise<{ ok: false; error: string } | { ok: true; amountCents: number; status: string }> {
  const { invoice } = input;
  const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));

  // How the customer pays is what decides whether this sale is taxed, and
  // the shop only finds out here. The first payment settles it: cash or
  // e-transfer strips the tax and re-prices the document, anything else
  // leaves it as issued. Checked AFTER the idempotency lookup so a retry of
  // an accepted payment still returns cleanly without re-pricing anything.
  const tax = resolvePaymentTax({
    invoice,
    method: input.method,
    taxLabel: input.taxLabel,
    alreadyPaidAgainst: payments.some((p) => p.status === "succeeded"),
  });
  if (!tax.ok) return { ok: false, error: tax.conflict };

  // Deliberately against the RE-PRICED total, and before anything is
  // written: an invoice sent at $197.75 owes $175.00 once cash strips the
  // tax, so tendering the taxed figure is refused rather than re-pricing
  // the document and then rejecting the payment that caused it.
  const summary = summarizePayments(tax.totalCents, invoice.depositAppliedCents, payments);
  const amountCents = input.amountCents === "balance" ? summary.balanceCents : input.amountCents;
  if (amountCents <= 0) return { ok: false, error: "Nothing is owing on this invoice" };
  if (amountCents > summary.balanceCents) {
    return { ok: false, error: `Amount exceeds the balance due (${formatCents(summary.balanceCents, input.currency)})` };
  }

  if (tax.changes) {
    await tx
      .update(schema.invoices)
      .set({ ...tax.changes, updatedAt: new Date() })
      .where(eq(schema.invoices.id, invoice.id));
    if (tax.changes.taxTreatment === "none") {
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: "invoice.tax_removed_by_payment_method",
        entityType: "invoice",
        entityId: invoice.id,
        before: { taxCents: invoice.taxCents, totalCents: invoice.totalCents, taxRateBp: invoice.taxRateBp },
        after: { taxCents: 0, totalCents: tax.totalCents, method: input.method },
        reason: tax.changes.taxExemptReason ?? undefined,
      });
    }
  }

  await tx.insert(schema.payments).values({
    id: newId("pay"),
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    provider: input.method,
    providerRef: input.reference || null,
    idempotencyKey: input.idempotencyKey,
    kind: "payment",
    amountCents,
    status: "succeeded",
    receivedAt: new Date(),
    recordedByStaffId: input.staffId,
  });

  const { status } = await recalculateInvoiceStatus(tx, invoice.id);

  await audit(tx, {
    actorType: "staff",
    actorId: input.staffId,
    action: "invoice.payment_recorded",
    entityType: "invoice",
    entityId: invoice.id,
    after: {
      method: input.method,
      amountCents,
      status,
      taxTreatment: tax.changes?.taxTreatment ?? invoice.taxTreatment,
      ...(input.reference ? { reference: input.reference } : {}),
      ...input.auditContext,
    },
  });
  return { ok: true, amountCents, status };
}

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

      const applied = await applyManualPayment(tx, {
        invoice,
        method: input.method,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        staffId: staff.id,
        taxLabel: settings.taxLabel,
        currency: settings.currency,
      });
      if (!applied.ok) return applied;
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
/* Fleet bulk payment — one cheque, many invoices                      */
/* ------------------------------------------------------------------ */

/**
 * Pays a fleet account's selected invoices in full, by one method, in one go.
 *
 * Fleets settle a month of bills with one cheque or transfer; before this, staff
 * opened each invoice and recorded its share by hand. Each invoice still gets
 * its own payment row (reports, receipts and refunds are all per invoice), for
 * exactly the balance owing once the method has settled the tax — so cash or
 * e-transfer strips HST from every invoice it pays, the same as one at a time.
 *
 * All or nothing: if any invoice cannot take this method (already part-paid the
 * other way, cancelled, paid meanwhile, another customer's), nothing is written
 * and the error names the invoice, so staff never have to work out which half
 * of a cheque landed.
 */
export async function recordFleetPaymentAction(
  raw: unknown,
): Promise<ActionResult<{ invoiceCount: number; totalCents: number }>> {
  try {
    const staff = await requireStaff("record_payments");
    const parsed = z
      .object({
        customerId: z.string().min(1),
        invoiceIds: z.array(z.string().min(1)).min(1).max(100),
        method: z.enum(MANUAL_PAYMENT_METHODS),
        reference: z.string().trim().max(100).optional(),
        sendReceipts: z.boolean().default(false),
        idempotencyKey: idempotencyKeySchema,
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose at least one invoice and a payment method" };
    const input = parsed.data;
    const invoiceIds = [...new Set(input.invoiceIds)].sort();
    const reference = input.reference || null;
    const settings = await getSettings();
    const keyFor = (invoiceId: string) => `${input.idempotencyKey}:${invoiceId}`;

    const result = await db().transaction(async (tx): Promise<
      ActionResult<{ newlyRecorded: boolean; paid: { invoiceId: string; amountCents: number }[] }>
    > => {
      // Locked in id order so two overlapping batches cannot deadlock.
      const invoices = await tx
        .select()
        .from(schema.invoices)
        .where(inArray(schema.invoices.id, invoiceIds))
        .orderBy(schema.invoices.id)
        .for("update");
      if (invoices.length !== invoiceIds.length || invoices.some((invoice) => invoice.customerId !== input.customerId)) {
        return { ok: false, error: "One of those invoices was not found on this account — refresh and try again" };
      }

      // A double-click or retry of a batch that already landed is a no-op.
      const existing = await tx
        .select()
        .from(schema.payments)
        .where(inArray(schema.payments.idempotencyKey, invoiceIds.map(keyFor)));
      if (existing.length > 0) {
        const sameBatch =
          existing.length === invoiceIds.length &&
          existing.every(
            (payment) =>
              payment.invoiceId !== null &&
              payment.idempotencyKey === keyFor(payment.invoiceId) &&
              payment.provider === input.method &&
              payment.kind === "payment" &&
              payment.status === "succeeded",
          );
        return sameBatch
          ? { ok: true, newlyRecorded: false, paid: existing.map((p) => ({ invoiceId: p.invoiceId!, amountCents: p.amountCents })) }
          : { ok: false, error: "That idempotency key was already used for a different payment" };
      }

      // Checked for the whole batch before anything is written: returning
      // part-way through the loop below would commit the invoices before it.
      const unpayable = invoices.find((invoice) => NOT_PAYABLE_STATUSES.has(invoice.status) || invoice.status === "paid");
      if (unpayable) {
        return { ok: false, error: `INV-${unpayable.number} is ${unpayable.status.replaceAll("_", " ")} and cannot take a payment` };
      }

      const paid: { invoiceId: string; amountCents: number }[] = [];
      for (const invoice of invoices) {
        const applied = await applyManualPayment(tx, {
          invoice,
          method: input.method,
          amountCents: "balance",
          idempotencyKey: keyFor(invoice.id),
          staffId: staff.id,
          taxLabel: settings.taxLabel,
          currency: settings.currency,
          reference,
          auditContext: { bulkPayment: input.idempotencyKey },
        });
        // Throwing (not returning) rolls back the invoices already paid in
        // this batch; the message is caught below and shown as-is.
        if (!applied.ok) throw new BulkPaymentRefused(`INV-${invoice.number}: ${applied.error}`);
        paid.push({ invoiceId: invoice.id, amountCents: applied.amountCents });
      }

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "customer.bulk_payment_recorded",
        entityType: "customer",
        entityId: input.customerId,
        after: {
          method: input.method,
          reference,
          batch: input.idempotencyKey,
          invoices: paid,
          totalCents: paid.reduce((sum, row) => sum + row.amountCents, 0),
        },
      });
      return { ok: true, newlyRecorded: true, paid };
    });
    if (!result.ok) return result;

    if (result.newlyRecorded && input.sendReceipts) {
      for (const row of result.paid) {
        try {
          await sendInvoiceReceipt(row.invoiceId, row.amountCents);
        } catch (err) {
          // Committed already; a failed receipt must not read as a failed payment.
          console.error("bulk payment recorded but receipt delivery failed", err);
        }
      }
    }

    for (const row of result.paid) revalidatePath(`/admin/invoices/${row.invoiceId}`);
    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/fleet/${input.customerId}`);
    return {
      ok: true,
      invoiceCount: result.paid.length,
      totalCents: result.paid.reduce((sum, row) => sum + row.amountCents, 0),
    };
  } catch (err) {
    if (err instanceof BulkPaymentRefused) return { ok: false, error: err.message };
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("recordFleetPaymentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/** Aborts a bulk payment's transaction with a message staff should see. */
class BulkPaymentRefused extends Error {}

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
        // "card" returns money to the card through Helcim; the rest are
        // refunds staff hand over themselves and record here.
        method: z.enum(["card", ...MANUAL_PAYMENT_METHODS]).default("cash"),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason and amount are required" };
    const input = parsed.data;
    const settings = await getSettings();

    const prepared = await db().transaction(async (tx): Promise<
      | { ok: false; error: string }
      | { ok: true; status: "succeeded"; route: "manual" }
      | { ok: true; status: "pending"; route: "card"; refundPaymentId: string }
    > => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      const provider = input.method === "card" ? "helcim" : input.method;

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
          (existing.provider === provider || (input.method === "card" && existing.provider === "helcim_terminal")) &&
          existing.amountCents === input.amountCents;
        if (!sameOperation) return { ok: false, error: "That idempotency key was already used for a different refund" };
        if (existing.status === "succeeded") return { ok: true, status: "succeeded", route: "manual" };
        if (input.method !== "card" || existing.status !== "pending") {
          return { ok: false, error: "That refund attempt failed; submit a new refund request" };
        }
        if (!decodeHelcimRefundReference(existing.providerRef)) {
          return { ok: false, error: "The pending card refund has invalid provider data" };
        }
        return { ok: true, status: "pending", route: "card", refundPaymentId: existing.id };
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
      if (input.method === "card") {
        if (input.amountCents > availability.cardRefundableCents) {
          return {
            ok: false,
            error: `Only ${formatCents(availability.cardRefundableCents, settings.currency)} remains refundable to the card`,
          };
        }
        const source = availability.cardSources.find((candidate) => candidate.refundableCents >= input.amountCents);
        if (!source) {
          const largest = Math.max(0, ...availability.cardSources.map((candidate) => candidate.refundableCents));
          return {
            ok: false,
            error: `Card payments are split across transactions; refund at most ${formatCents(largest, settings.currency)} per request`,
          };
        }
        const sourcePayment = payments.find((payment) => payment.id === source.paymentId);
        const refundPaymentId = newId("pay");
        await tx.insert(schema.payments).values({
          id: refundPaymentId,
          invoiceId: input.invoiceId,
          customerId: invoice.customerId,
          provider: sourcePayment?.provider ?? "helcim",
          providerRef: encodeHelcimRefundReference({
            sourcePaymentId: source.paymentId,
            sourceTransactionId: source.transactionId,
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
          after: { refundPaymentId, amountCents: input.amountCents, provider: "helcim", sourceTransactionId: source.transactionId },
          reason: input.reason,
        });
        return { ok: true, status: "pending", route: "card", refundPaymentId };
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

    const result = await executeCardRefund({ refundPaymentId: prepared.refundPaymentId, ipAddress: await requestIp() });
    revalidatePath(`/admin/invoices/${input.invoiceId}`);
    revalidatePath("/admin/invoices");
    if (result.status === "failed") return { ok: false, error: result.message ?? "Helcim declined the refund" };
    if (result.status === "pending") {
      return { ok: false, error: result.message ?? "Helcim did not confirm the refund. Retry the same request safely." };
    }
    return { ok: true, status: "succeeded" };
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

      // Release the jobs this invoice held, so cancelling is genuinely
      // "cancel and re-issue" rather than a dead end.
      //
      // Until this existed, cancelling left `jobs.invoice_id` set and the
      // `invoice_jobs` row in place. `invoice_jobs_job_uq` is unique on job_id
      // and createInvoiceFromJobAction refuses a job that already has an
      // invoice, so a cancelled job-derived invoice could never be replaced —
      // staff were pushed into a manual invoice that dropped the job link, the
      // deposit application and the promo provenance.
      //
      // The cancelled invoice keeps its number and its line items: it stays a
      // readable historical document. Only the CLAIM on the job is released.
      const releasedJobs = await tx
        .select({ jobId: schema.invoiceJobs.jobId })
        .from(schema.invoiceJobs)
        .where(eq(schema.invoiceJobs.invoiceId, input.invoiceId));
      const releasedJobIds = releasedJobs.map((row) => row.jobId);
      if (releasedJobIds.length > 0) {
        await tx.delete(schema.invoiceJobs).where(eq(schema.invoiceJobs.invoiceId, input.invoiceId));
        await tx
          .update(schema.jobs)
          .set({ invoiceId: null, updatedAt: new Date() })
          .where(inArray(schema.jobs.id, releasedJobIds));
      }
      // The legacy single-job pointer predates invoice_jobs and is not always
      // mirrored there, so clear it on its own terms too.
      if (invoice.jobId && !releasedJobIds.includes(invoice.jobId)) {
        await tx
          .update(schema.jobs)
          .set({ invoiceId: null, updatedAt: new Date() })
          .where(eq(schema.jobs.id, invoice.jobId));
        releasedJobIds.push(invoice.jobId);
      }

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.cancelled",
        entityType: "invoice",
        entityId: input.invoiceId,
        before: { status: invoice.status },
        after: { status: "cancelled", releasedJobIds },
        reason: input.reason,
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath(`/admin/invoices/${input.invoiceId}`);
      revalidatePath("/admin/invoices");
      // The released jobs are invoiceable again, so their screens are stale.
      revalidatePath("/admin/jobs");
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
  /**
   * Optional note on why a discount was given, shown on the invoice when
   * present. Deliberately NOT required: the owner does not want to explain a
   * discount to raise an invoice, and blocking on it only slowed the counter
   * down. See DECISIONS.md #18.
   */
  discountReason: z.string().trim().max(200).optional(),
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
    // self-describing; the flag and reason record WHY it was zero. Everything
    // else is raised WITH tax — whether the customer's payment method strips it
    // is settled when the payment is recorded, not here.
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
        taxTreatment: input.taxExempt ? "none" : "added",
        discountReason: totals.discountCents > 0 ? (input.discountReason ?? null) : null,
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
          discountCents: totals.discountCents,
          backdated: Boolean(input.invoiceDateISO),
        },
        reason: (input.taxExempt ? input.taxExemptReason : null) ?? input.discountReason ?? undefined,
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
      // The tip rides across untouched. It is not part of the lines and is not
      // taxed, so exempting the work must leave the gratuity exactly as it was;
      // omitting it here would rebuild the total without it and quietly erase
      // money the customer chose to add.
      const totals = computeInvoiceTotals(lines, invoice.discountCents, taxRateBp, invoice.tipCents);

      await tx
        .update(schema.invoices)
        .set({
          taxRateBp,
          taxCents: totals.taxCents,
          taxExempt: input.taxExempt,
          taxExemptReason: input.taxExempt ? input.reason : null,
          // `taxTreatment` records what the document does, so it has to follow.
          // `quotedPaymentMethod` is cleared: a staff exemption is a reason
          // that has nothing to do with how the customer pays, and leaving the
          // old method here would go on blocking payments under a rule that no
          // longer applies to this invoice.
          taxTreatment: input.taxExempt ? "none" : "added",
          quotedPaymentMethod: null,
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

/* ------------------------------------------------------------------ */
/* Tips                                                                */
/* ------------------------------------------------------------------ */

/**
 * Sets (or clears) the gratuity on an invoice, as a percentage of the work or
 * as a flat amount, and lets the status follow the new balance.
 *
 * DELIBERATELY ALLOWED AFTER PAYMENT, unlike setInvoiceTaxExemptAction. A tip
 * is not a re-pricing of the work — it is money the customer decided to add
 * once the job was done, which is usually at the moment they pay and sometimes
 * after. Refusing it on a paid invoice is what forced the shop to have no way
 * to record a tip a customer had already handed over.
 *
 * The total is rebuilt from the STORED snapshot (`totalCents - old tip + new
 * tip`), never recomputed from the line items. An invoice settled in cash has
 * already had its HST stripped by resolvePaymentTax, and recomputing from lines
 * would quietly put that tax back on a document the customer has paid.
 */
export async function setInvoiceTipAction(raw: unknown): Promise<ActionResult<{ tipCents: number }>> {
  try {
    const staff = await requireStaff("manage_invoices");
    const parsed = z
      .object({
        invoiceId: z.string().min(1),
        // Exactly one of the two. A percentage is resolved to cents here,
        // against the stored subtotal — the browser never supplies an amount
        // derived from a total it computed itself.
        basisPoints: z.number().int().min(0).max(MAX_TIP_BP).optional(),
        tipCents: z.number().int().min(0).max(1_000_000).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the tip amount" };
    const input = parsed.data;
    if ((input.basisPoints === undefined) === (input.tipCents === undefined)) {
      return { ok: false, error: "Give the tip either as a percentage or as an amount" };
    }
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ tipCents: number }>> => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
      const invoice = rows[0];
      if (!invoice) return { ok: false, error: "Invoice not found" };
      if (["cancelled", "refunded"].includes(invoice.status)) {
        return { ok: false, error: `A ${invoice.status} invoice cannot take a tip` };
      }

      const nextTipCents =
        input.basisPoints !== undefined
          ? tipCentsFromBasisPoints(invoice.subtotalCents, invoice.discountCents, input.basisPoints)
          : input.tipCents!;
      if (nextTipCents === invoice.tipCents) {
        return { ok: true, tipCents: nextTipCents };
      }

      // A flat amount gets the same sanity cap the percentage buttons have, so
      // the two routes cannot disagree about what counts as a typo.
      const capCents = tipCentsFromBasisPoints(invoice.subtotalCents, invoice.discountCents, MAX_TIP_BP);
      if (nextTipCents > capCents) {
        return {
          ok: false,
          error: `That tip is more than the work itself (${formatCents(capCents, settings.currency)}) — check the amount`,
        };
      }

      // Rebuild from the snapshot, not the lines. See the note above.
      const totalCents = invoice.totalCents - invoice.tipCents + nextTipCents;

      // Lowering a tip must never take the total below money already banked:
      // summarizePayments clamps the balance at zero, so an overpayment would
      // vanish silently instead of surfacing as a refund the shop has to make.
      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      const { netPaidCents } = summarizePayments(totalCents, invoice.depositAppliedCents, payments);
      if (totalCents < netPaidCents) {
        return {
          ok: false,
          error: `That would drop the total below the ${formatCents(netPaidCents, settings.currency)} already paid — refund the difference instead`,
        };
      }

      await tx
        .update(schema.invoices)
        .set({
          tipCents: nextTipCents,
          // Cleared when the tip is typed as an amount or removed, so the
          // document never prints a percentage that no longer describes it.
          tipBasisBp: nextTipCents > 0 && input.basisPoints !== undefined ? input.basisPoints : null,
          totalCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.invoices.id, invoice.id));

      // The balance moved, so the status has to follow: adding a tip to a paid
      // invoice reopens it as partially_paid, which is exactly what lets the
      // tip itself be recorded as a payment.
      const { status } = await recalculateInvoiceStatus(tx, invoice.id);

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.tip_set",
        entityType: "invoice",
        entityId: invoice.id,
        before: { tipCents: invoice.tipCents, tipBasisBp: invoice.tipBasisBp, totalCents: invoice.totalCents },
        after: { tipCents: nextTipCents, basisPoints: input.basisPoints ?? null, totalCents, status },
      });
      return { ok: true, tipCents: nextTipCents };
    });

    if (result.ok) {
      revalidatePath("/admin/invoices");
      revalidatePath(`/admin/invoices/${input.invoiceId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("setInvoiceTipAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Smart Terminal                                                       */
/* ------------------------------------------------------------------ */

export type TerminalStatus =
  | { ok: true; state: "waiting" | "paid"; amountCents: number; tipCents?: number }
  | { ok: true; state: "failed"; reason: string }
  | { ok: false; error: string };

/** Sends the invoice's balance to the counter's Smart Terminal. */
export async function startTerminalCollectionAction(
  raw: unknown,
): Promise<ActionResult<{ checkoutId: string; amountCents: number }>> {
  try {
    const staff = await requireStaff("record_payments");
    const parsed = z.object({ invoiceId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const result = await startInvoiceTerminalCheckout({ invoiceId: parsed.data.invoiceId, staffId: staff.id });
    if (!result.ok) return result;
    return { ok: true, checkoutId: result.checkoutId, amountCents: result.amountCents };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("startTerminalCollectionAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const lastTerminalCheck = new Map<string, number>();

/**
 * Polled by the waiting screen. The webhook normally settles the payment the
 * moment the customer taps; this also asks Helcim directly every few seconds,
 * so the counter is never stuck waiting on a webhook that was delayed.
 */
export async function pollTerminalCollectionAction(raw: unknown): Promise<TerminalStatus> {
  try {
    await requireStaff("record_payments");
    const parsed = z.object({ checkoutId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { checkoutId } = parsed.data;
    const load = async () =>
      (await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, checkoutId)).limit(1))[0];
    let checkout = await load();
    if (!checkout || checkout.channel !== "terminal") return { ok: false, error: "Payment request not found" };
    if (checkout.status === "open") {
      const last = lastTerminalCheck.get(checkoutId) ?? 0;
      if (Date.now() - last > 6_000 && Date.now() - checkout.createdAt.getTime() > 8_000) {
        lastTerminalCheck.set(checkoutId, Date.now());
        await reconcileCheckout(checkoutId).catch((error) => console.error("terminal poll reconcile failed", error));
        checkout = (await load())!;
      }
    }
    if (checkout.status === "succeeded") {
      lastTerminalCheck.delete(checkoutId);
      const paid = fromHelcimAmount((checkout.transaction as { amount?: unknown } | null)?.amount);
      const amountCents = Number.isFinite(paid) ? paid : checkout.amountCents;
      return { ok: true, state: "paid", amountCents, tipCents: Math.max(0, amountCents - checkout.amountCents) };
    }
    if (checkout.status === "failed" || checkout.status === "expired") {
      lastTerminalCheck.delete(checkoutId);
      return { ok: true, state: "failed", reason: checkout.failureReason ?? "The payment did not go through" };
    }
    return { ok: true, state: "waiting", amountCents: checkout.amountCents };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("pollTerminalCollectionAction failed", err);
    return { ok: false, error: "Could not check the terminal" };
  }
}

/**
 * Stops waiting. If the customer does tap after this, the payment is still
 * recorded when Helcim reports it — a late success is never thrown away.
 */
export async function stopTerminalCollectionAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("record_payments");
    const parsed = z.object({ checkoutId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const outcome = await reconcileCheckout(parsed.data.checkoutId);
    if (outcome.status === "succeeded") return { ok: false, error: "That payment has already gone through." };
    await db().transaction(async (tx) => {
      await closeCheckout(tx, parsed.data.checkoutId, "failed", "Stopped by staff before the card was tapped");
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "invoice.terminal_payment_stopped",
        entityType: "payment_checkout",
        entityId: parsed.data.checkoutId,
      });
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("stopTerminalCollectionAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
