import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { db, schema } from "@/db";
import type { Attribution } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";

export const REPORT_DAY_OPTIONS = [7, 30, 90] as const;
export type ReportDays = (typeof REPORT_DAY_OPTIONS)[number];

export type ReportWindow = {
  days: number;
  start: Date;
  end: Date;
};

type PaymentLike = {
  kind: string;
  amountCents: number;
  status: string;
};

export type RevenueSummary = {
  grossCents: number;
  refundCents: number;
  netCents: number;
  paymentCount: number;
  refundCount: number;
};

export type SourceRevenue = RevenueSummary & { source: string };

export type FunnelStage = {
  key: "leads" | "customers" | "booked" | "completed";
  label: string;
  count: number;
  stepRate: number | null;
  overallRate: number | null;
};

export type LeadFunnel = {
  stages: FunnelStage[];
  quoteLeadCount: number;
  estimatedLeadCount: number;
  leadToBookingRate: number | null;
  leadToCompletionRate: number | null;
};

export type ResourceUtilization = {
  resourceId: string;
  name: string;
  type: string;
  bookedMinutes: number;
  availableMinutes: number;
  utilizationRate: number | null;
};

export type UtilizationSummary = {
  resources: ResourceUtilization[];
  bookedMinutes: number;
  availableMinutes: number;
  utilizationRate: number | null;
  unassignedBookedMinutes: number;
};

export type ReportingSnapshot = {
  window: ReportWindow;
  timezone: string;
  currency: string;
  revenue: RevenueSummary;
  funnel: LeadFunnel;
  utilization: UtilizationSummary;
  sourceRevenue: SourceRevenue[];
};

const DAY_MS = 86_400_000;
const NON_CAPACITY_STATUSES = new Set(["cancelled", "no_show", "rescheduled"]);

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/** A range of whole business-local calendar days, ending after today. */
export function getReportWindow(days: number, timeZone: string, now = new Date()): ReportWindow {
  if (!Number.isInteger(days) || days < 1) throw new Error("Report days must be a positive integer");
  const today = localDateParts(now, timeZone);
  const todayKey = Date.UTC(today.year, today.month - 1, today.day);
  const startCalendar = new Date(todayKey - (days - 1) * DAY_MS);
  const endCalendar = new Date(todayKey + DAY_MS);
  const start = zonedToUtc(
    timeZone,
    startCalendar.getUTCFullYear(),
    startCalendar.getUTCMonth() + 1,
    startCalendar.getUTCDate(),
    0,
    0,
  );
  const end = zonedToUtc(
    timeZone,
    endCalendar.getUTCFullYear(),
    endCalendar.getUTCMonth() + 1,
    endCalendar.getUTCDate(),
    0,
    0,
  );
  return { days, start, end };
}

export function parseReportDays(value: string | undefined): ReportDays {
  const parsed = Number(value);
  return REPORT_DAY_OPTIONS.includes(parsed as ReportDays) ? (parsed as ReportDays) : 30;
}

/** Cash-basis revenue: succeeded incoming payments/deposits less succeeded refunds. */
export function summarizeRevenue(rows: readonly PaymentLike[]): RevenueSummary {
  let grossCents = 0;
  let refundCents = 0;
  let paymentCount = 0;
  let refundCount = 0;
  for (const row of rows) {
    if (row.status !== "succeeded") continue;
    const amount = Math.max(0, row.amountCents);
    if (row.kind === "refund") {
      refundCents += amount;
      refundCount += 1;
    } else {
      grossCents += amount;
      paymentCount += 1;
    }
  }
  return {
    grossCents,
    refundCents,
    netCents: grossCents - refundCents,
    paymentCount,
    refundCount,
  };
}

function normalizeSource(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function attributionSource(attribution: Attribution | null | undefined): string | null {
  if (!attribution) return null;
  return (
    normalizeSource(attribution.source) ??
    normalizeSource(attribution.manualSource) ??
    normalizeSource(attribution.utm?.utm_source) ??
    normalizeSource(attribution.firstTouch?.utm_source) ??
    normalizeSource(attribution.lastTouch?.utm_source)
  );
}

export function groupRevenueBySource(
  rows: readonly (PaymentLike & { source?: string | null })[],
): SourceRevenue[] {
  const grouped = new Map<string, PaymentLike[]>();
  for (const row of rows) {
    const source = normalizeSource(row.source) ?? "unattributed";
    const current = grouped.get(source) ?? [];
    current.push(row);
    grouped.set(source, current);
  }
  return [...grouped.entries()]
    .map(([source, payments]) => ({ source, ...summarizeRevenue(payments) }))
    .sort((a, b) => b.netCents - a.netCents || a.source.localeCompare(b.source));
}

type SourceContext = {
  appointmentsById: ReadonlyMap<
    string,
    { attribution: Attribution | null; customerId: string }
  >;
  invoicesById: ReadonlyMap<string, { jobId: string | null; customerId: string }>;
  jobsById: ReadonlyMap<string, { appointmentId: string | null; customerId: string }>;
  customersById: ReadonlyMap<string, { sourceLeadId: string | null }>;
  leadsById: ReadonlyMap<string, { attribution: Attribution | null }>;
};

export function resolvePaymentSource(
  payment: { appointmentId: string | null; invoiceId: string | null; customerId: string | null },
  context: SourceContext,
): string {
  const invoice = payment.invoiceId ? context.invoicesById.get(payment.invoiceId) : undefined;
  const job = invoice?.jobId ? context.jobsById.get(invoice.jobId) : undefined;
  const appointmentId = payment.appointmentId ?? job?.appointmentId ?? null;
  const appointment = appointmentId ? context.appointmentsById.get(appointmentId) : undefined;
  const directSource = attributionSource(appointment?.attribution);
  if (directSource) return directSource;

  const customerId =
    payment.customerId ?? appointment?.customerId ?? invoice?.customerId ?? job?.customerId ?? null;
  const customer = customerId ? context.customersById.get(customerId) : undefined;
  const lead = customer?.sourceLeadId ? context.leadsById.get(customer.sourceLeadId) : undefined;
  return attributionSource(lead?.attribution) ?? "unattributed";
}

type FunnelInput = {
  leads: readonly { id: string; status: string; convertedCustomerId: string | null }[];
  quotes: readonly { id: string; leadId: string | null }[];
  estimates: readonly { id: string; quoteRequestId: string | null }[];
  customers: readonly { id: string; sourceLeadId: string | null }[];
  appointments: readonly {
    id: string;
    customerId: string;
    estimateId: string | null;
    status: string;
  }[];
  jobs: readonly { appointmentId: string | null; status: string }[];
};

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Builds a strict lead cohort funnel. Later stages are unique leads, not raw
 * entity counts, so repeat appointments do not inflate conversion.
 */
export function computeLeadFunnel(input: FunnelInput): LeadFunnel {
  const leadIds = new Set(input.leads.map((lead) => lead.id));
  const leadByQuoteId = new Map<string, string>();
  const quotedLeadIds = new Set<string>();
  for (const quote of input.quotes) {
    if (quote.leadId && leadIds.has(quote.leadId)) {
      leadByQuoteId.set(quote.id, quote.leadId);
      quotedLeadIds.add(quote.leadId);
    }
  }

  const leadByEstimateId = new Map<string, string>();
  const estimatedLeadIds = new Set<string>();
  for (const estimate of input.estimates) {
    const leadId = estimate.quoteRequestId
      ? leadByQuoteId.get(estimate.quoteRequestId)
      : undefined;
    if (leadId) {
      leadByEstimateId.set(estimate.id, leadId);
      estimatedLeadIds.add(leadId);
    }
  }

  const leadByCustomerId = new Map<string, string>();
  const convertedLeadIds = new Set<string>();
  for (const lead of input.leads) {
    if (lead.convertedCustomerId) {
      leadByCustomerId.set(lead.convertedCustomerId, lead.id);
      convertedLeadIds.add(lead.id);
    }
    if (lead.status === "converted") convertedLeadIds.add(lead.id);
  }
  for (const customer of input.customers) {
    if (customer.sourceLeadId && leadIds.has(customer.sourceLeadId)) {
      leadByCustomerId.set(customer.id, customer.sourceLeadId);
      convertedLeadIds.add(customer.sourceLeadId);
    }
  }

  const leadByAppointmentId = new Map<string, string>();
  const bookedLeadIds = new Set<string>();
  const completedLeadIds = new Set<string>();
  for (const appointment of input.appointments) {
    const leadId =
      (appointment.estimateId ? leadByEstimateId.get(appointment.estimateId) : undefined) ??
      leadByCustomerId.get(appointment.customerId);
    if (!leadId || !leadIds.has(leadId)) continue;
    leadByAppointmentId.set(appointment.id, leadId);
    bookedLeadIds.add(leadId);
    convertedLeadIds.add(leadId);
    if (appointment.status === "completed") completedLeadIds.add(leadId);
  }
  for (const job of input.jobs) {
    if (job.status !== "completed" || !job.appointmentId) continue;
    const leadId = leadByAppointmentId.get(job.appointmentId);
    if (leadId) completedLeadIds.add(leadId);
  }

  const counts = [
    { key: "leads" as const, label: "Leads captured", count: leadIds.size },
    { key: "customers" as const, label: "Converted customers", count: convertedLeadIds.size },
    { key: "booked" as const, label: "Booked", count: bookedLeadIds.size },
    { key: "completed" as const, label: "Completed jobs", count: completedLeadIds.size },
  ];
  const stages = counts.map((stage, index) => ({
    ...stage,
    stepRate: index === 0 ? null : rate(stage.count, counts[index - 1].count),
    overallRate: index === 0 ? null : rate(stage.count, counts[0].count),
  }));

  return {
    stages,
    quoteLeadCount: quotedLeadIds.size,
    estimatedLeadCount: estimatedLeadIds.size,
    leadToBookingRate: rate(bookedLeadIds.size, leadIds.size),
    leadToCompletionRate: rate(completedLeadIds.size, leadIds.size),
  };
}

type Interval = { start: Date; end: Date };

type UtilizationInput = {
  window: ReportWindow;
  timeZone: string;
  resources: readonly { id: string; name: string; type: string; active: boolean }[];
  businessHours: readonly {
    weekday: number;
    open: string | null;
    close: string | null;
    closed: boolean;
  }[];
  blocks: readonly {
    resourceId: string | null;
    staffUserId: string | null;
    startsAt: Date;
    endsAt: Date;
  }[];
  appointments: readonly {
    resourceId: string | null;
    status: string;
    startsAt: Date;
    endsAt: Date;
  }[];
};

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function clipInterval(interval: Interval, window: Interval): Interval | null {
  const start = new Date(Math.max(interval.start.getTime(), window.start.getTime()));
  const end = new Date(Math.min(interval.end.getTime(), window.end.getTime()));
  return start < end ? { start, end } : null;
}

function mergedMinutes(intervals: readonly Interval[]): number {
  const sorted = intervals
    .filter((interval) => interval.start < interval.end)
    .map((interval) => ({ start: interval.start.getTime(), end: interval.end.getTime() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return 0;
  let minutes = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      minutes += (end - start) / 60_000;
      start = interval.start;
      end = interval.end;
    }
  }
  return minutes + (end - start) / 60_000;
}

function summedMinutes(intervals: readonly Interval[]): number {
  return intervals.reduce(
    (minutes, interval) => minutes + (interval.end.getTime() - interval.start.getTime()) / 60_000,
    0,
  );
}

function openIntervals(input: UtilizationInput): Interval[] {
  const hoursByWeekday = new Map(input.businessHours.map((hours) => [hours.weekday, hours]));
  const localStart = localDateParts(input.window.start, input.timeZone);
  const localEnd = localDateParts(new Date(input.window.end.getTime() - 1), input.timeZone);
  const startKey = Date.UTC(localStart.year, localStart.month - 1, localStart.day);
  const endKey = Date.UTC(localEnd.year, localEnd.month - 1, localEnd.day);
  const result: Interval[] = [];

  for (let key = startKey; key <= endKey; key += DAY_MS) {
    const day = new Date(key);
    const hours = hoursByWeekday.get(day.getUTCDay());
    if (!hours || hours.closed || !hours.open || !hours.close) continue;
    const open = parseTime(hours.open);
    const close = parseTime(hours.close);
    if (!open || !close) continue;
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    const startsAt = zonedToUtc(input.timeZone, year, month, date, open.hour, open.minute);
    let closesAt = zonedToUtc(input.timeZone, year, month, date, close.hour, close.minute);
    if (closesAt <= startsAt) {
      const next = new Date(key + DAY_MS);
      closesAt = zonedToUtc(
        input.timeZone,
        next.getUTCFullYear(),
        next.getUTCMonth() + 1,
        next.getUTCDate(),
        close.hour,
        close.minute,
      );
    }
    const clipped = clipInterval(
      { start: startsAt, end: closesAt },
      { start: input.window.start, end: input.window.end },
    );
    if (clipped) result.push(clipped);
  }
  return result;
}

function blockedMinutes(open: readonly Interval[], blocks: readonly Interval[]): number {
  const overlaps: Interval[] = [];
  for (const availability of open) {
    for (const block of blocks) {
      const overlap = clipInterval(block, availability);
      if (overlap) overlaps.push(overlap);
    }
  }
  return mergedMinutes(overlaps);
}

export function computeResourceUtilization(input: UtilizationInput): UtilizationSummary {
  const open = openIntervals(input);
  const openMinutes = mergedMinutes(open);
  const reportWindow = { start: input.window.start, end: input.window.end };
  const appointments = input.appointments.filter(
    (appointment) =>
      !NON_CAPACITY_STATUSES.has(appointment.status) && appointment.startsAt < appointment.endsAt,
  );

  const resources = input.resources
    .filter((resource) => resource.active)
    .map((resource) => {
      const resourceBlocks = input.blocks
        .filter(
          (block) =>
            block.resourceId === resource.id ||
            (block.resourceId === null && block.staffUserId === null),
        )
        .map((block) => ({ start: block.startsAt, end: block.endsAt }));
      const availableMinutes = Math.max(0, openMinutes - blockedMinutes(open, resourceBlocks));
      const bookedMinutes = mergedMinutes(
        appointments
          .filter((appointment) => appointment.resourceId === resource.id)
          .map((appointment) =>
            clipInterval(
              { start: appointment.startsAt, end: appointment.endsAt },
              reportWindow,
            ),
          )
          .filter((interval): interval is Interval => interval !== null),
      );
      return {
        resourceId: resource.id,
        name: resource.name,
        type: resource.type,
        bookedMinutes,
        availableMinutes,
        utilizationRate: rate(bookedMinutes, availableMinutes),
      };
    })
    .sort((a, b) => b.bookedMinutes - a.bookedMinutes || a.name.localeCompare(b.name));

  const bookedMinutes = resources.reduce((sum, resource) => sum + resource.bookedMinutes, 0);
  const availableMinutes = resources.reduce((sum, resource) => sum + resource.availableMinutes, 0);
  // Unassigned appointments are separate pieces of work, so overlapping rows
  // must be added rather than unioned as they are for one concrete resource.
  const unassignedBookedMinutes = summedMinutes(
    appointments
      .filter((appointment) => appointment.resourceId === null)
      .map((appointment) =>
        clipInterval({ start: appointment.startsAt, end: appointment.endsAt }, reportWindow),
      )
      .filter((interval): interval is Interval => interval !== null),
  );
  return {
    resources,
    bookedMinutes,
    availableMinutes,
    utilizationRate: rate(bookedMinutes, availableMinutes),
    unassignedBookedMinutes,
  };
}

function unique<T>(values: readonly (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null && value !== undefined))];
}

/** Loads one complete reporting snapshot. All calculations remain in the pure helpers above. */
export async function getReportingSnapshot(days: ReportDays, now = new Date()): Promise<ReportingSnapshot> {
  const settings = await getSettings();
  const window = getReportWindow(days, settings.timezone, now);
  const paymentOccurredInWindow = or(
    and(
      isNotNull(schema.payments.receivedAt),
      gte(schema.payments.receivedAt, window.start),
      lt(schema.payments.receivedAt, window.end),
    ),
    and(
      isNull(schema.payments.receivedAt),
      gte(schema.payments.createdAt, window.start),
      lt(schema.payments.createdAt, window.end),
    ),
  );

  const [paymentRows, leadRows, resourceRows, hoursRows, blockRows, utilizationAppointments] =
    await Promise.all([
      db()
        .select({
          id: schema.payments.id,
          invoiceId: schema.payments.invoiceId,
          appointmentId: schema.payments.appointmentId,
          customerId: schema.payments.customerId,
          kind: schema.payments.kind,
          amountCents: schema.payments.amountCents,
          status: schema.payments.status,
        })
        .from(schema.payments)
        .where(and(eq(schema.payments.status, "succeeded"), paymentOccurredInWindow)),
      db()
        .select({
          id: schema.leads.id,
          status: schema.leads.status,
          convertedCustomerId: schema.leads.convertedCustomerId,
        })
        .from(schema.leads)
        .where(and(gte(schema.leads.createdAt, window.start), lt(schema.leads.createdAt, window.end))),
      db()
        .select({ id: schema.resources.id, name: schema.resources.name, type: schema.resources.type, active: schema.resources.active })
        .from(schema.resources)
        .where(eq(schema.resources.active, true)),
      db()
        .select({
          weekday: schema.businessHours.weekday,
          open: schema.businessHours.open,
          close: schema.businessHours.close,
          closed: schema.businessHours.closed,
        })
        .from(schema.businessHours),
      db()
        .select({
          resourceId: schema.scheduleBlocks.resourceId,
          staffUserId: schema.scheduleBlocks.staffUserId,
          startsAt: schema.scheduleBlocks.startsAt,
          endsAt: schema.scheduleBlocks.endsAt,
        })
        .from(schema.scheduleBlocks)
        .where(
          and(
            lt(schema.scheduleBlocks.startsAt, window.end),
            gt(schema.scheduleBlocks.endsAt, window.start),
          ),
        ),
      db()
        .select({
          resourceId: schema.appointments.resourceId,
          status: schema.appointments.status,
          startsAt: schema.appointments.startsAt,
          endsAt: schema.appointments.endsAt,
        })
        .from(schema.appointments)
        .where(
          and(
            lt(schema.appointments.startsAt, window.end),
            gt(schema.appointments.endsAt, window.start),
          ),
        ),
    ]);

  const invoiceIds = unique(paymentRows.map((payment) => payment.invoiceId));
  const invoiceRows = invoiceIds.length
    ? await db()
        .select({ id: schema.invoices.id, jobId: schema.invoices.jobId, customerId: schema.invoices.customerId })
        .from(schema.invoices)
        .where(inArray(schema.invoices.id, invoiceIds))
    : [];
  const jobIds = unique(invoiceRows.map((invoice) => invoice.jobId));
  const revenueJobRows = jobIds.length
    ? await db()
        .select({ id: schema.jobs.id, appointmentId: schema.jobs.appointmentId, customerId: schema.jobs.customerId })
        .from(schema.jobs)
        .where(inArray(schema.jobs.id, jobIds))
    : [];
  const revenueAppointmentIds = unique([
    ...paymentRows.map((payment) => payment.appointmentId),
    ...revenueJobRows.map((job) => job.appointmentId),
  ]);
  const revenueAppointmentRows = revenueAppointmentIds.length
    ? await db()
        .select({
          id: schema.appointments.id,
          customerId: schema.appointments.customerId,
          attribution: schema.appointments.attribution,
        })
        .from(schema.appointments)
        .where(inArray(schema.appointments.id, revenueAppointmentIds))
    : [];
  const revenueCustomerIds = unique([
    ...paymentRows.map((payment) => payment.customerId),
    ...invoiceRows.map((invoice) => invoice.customerId),
    ...revenueJobRows.map((job) => job.customerId),
    ...revenueAppointmentRows.map((appointment) => appointment.customerId),
  ]);
  const revenueCustomerRows = revenueCustomerIds.length
    ? await db()
        .select({ id: schema.customers.id, sourceLeadId: schema.customers.sourceLeadId })
        .from(schema.customers)
        .where(inArray(schema.customers.id, revenueCustomerIds))
    : [];
  const sourceLeadIds = unique(revenueCustomerRows.map((customer) => customer.sourceLeadId));
  const sourceLeadRows = sourceLeadIds.length
    ? await db()
        .select({ id: schema.leads.id, attribution: schema.leads.attribution })
        .from(schema.leads)
        .where(inArray(schema.leads.id, sourceLeadIds))
    : [];
  const sourceContext: SourceContext = {
    appointmentsById: new Map(revenueAppointmentRows.map((row) => [row.id, row])),
    invoicesById: new Map(invoiceRows.map((row) => [row.id, row])),
    jobsById: new Map(revenueJobRows.map((row) => [row.id, row])),
    customersById: new Map(revenueCustomerRows.map((row) => [row.id, row])),
    leadsById: new Map(sourceLeadRows.map((row) => [row.id, row])),
  };
  const attributedPayments = paymentRows.map((payment) => ({
    ...payment,
    source: resolvePaymentSource(payment, sourceContext),
  }));

  const cohortLeadIds = leadRows.map((lead) => lead.id);
  const quoteRows = cohortLeadIds.length
    ? await db()
        .select({ id: schema.quoteRequests.id, leadId: schema.quoteRequests.leadId })
        .from(schema.quoteRequests)
        .where(inArray(schema.quoteRequests.leadId, cohortLeadIds))
    : [];
  const quoteIds = quoteRows.map((quote) => quote.id);
  const estimateRows = quoteIds.length
    ? await db()
        .select({ id: schema.estimates.id, quoteRequestId: schema.estimates.quoteRequestId })
        .from(schema.estimates)
        .where(inArray(schema.estimates.quoteRequestId, quoteIds))
    : [];
  const convertedCustomerIds = unique(leadRows.map((lead) => lead.convertedCustomerId));
  const sourceCustomerRows = cohortLeadIds.length
    ? await db()
        .select({ id: schema.customers.id, sourceLeadId: schema.customers.sourceLeadId })
        .from(schema.customers)
        .where(inArray(schema.customers.sourceLeadId, cohortLeadIds))
    : [];
  const funnelCustomerIds = unique([
    ...convertedCustomerIds,
    ...sourceCustomerRows.map((customer) => customer.id),
  ]);
  const estimateIds = estimateRows.map((estimate) => estimate.id);
  const appointmentScope = [
    ...(funnelCustomerIds.length ? [inArray(schema.appointments.customerId, funnelCustomerIds)] : []),
    ...(estimateIds.length ? [inArray(schema.appointments.estimateId, estimateIds)] : []),
  ];
  const funnelAppointments = appointmentScope.length
    ? await db()
        .select({
          id: schema.appointments.id,
          customerId: schema.appointments.customerId,
          estimateId: schema.appointments.estimateId,
          status: schema.appointments.status,
        })
        .from(schema.appointments)
        .where(and(or(...appointmentScope), lt(schema.appointments.createdAt, window.end)))
    : [];
  const funnelAppointmentIds = funnelAppointments.map((appointment) => appointment.id);
  const funnelJobs = funnelAppointmentIds.length
    ? await db()
        .select({ appointmentId: schema.jobs.appointmentId, status: schema.jobs.status })
        .from(schema.jobs)
        .where(inArray(schema.jobs.appointmentId, funnelAppointmentIds))
    : [];

  return {
    window,
    timezone: settings.timezone,
    currency: settings.currency,
    revenue: summarizeRevenue(paymentRows),
    sourceRevenue: groupRevenueBySource(attributedPayments),
    funnel: computeLeadFunnel({
      leads: leadRows,
      quotes: quoteRows,
      estimates: estimateRows,
      customers: sourceCustomerRows,
      appointments: funnelAppointments,
      jobs: funnelJobs,
    }),
    utilization: computeResourceUtilization({
      window,
      timeZone: settings.timezone,
      resources: resourceRows,
      businessHours: hoursRows,
      blocks: blockRows,
      appointments: utilizationAppointments,
    }),
  };
}
