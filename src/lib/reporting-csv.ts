import "server-only";

import { and, asc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { PAYMENT_PROVIDER_LABELS } from "@/lib/payment-labels";
import { getSettings } from "@/lib/settings";
import { getReportWindow, type ReportDays, type ReportingSnapshot } from "@/lib/reporting";
import {
  getPeriodWindow,
  listExpenses,
  type BooksSnapshot,
  type PeriodKind,
} from "@/lib/books";

/**
 * CSV exports for the reports screen. Everything is emitted as whole dollars
 * with a period decimal separator so Excel and Google Sheets parse the numbers
 * without a locale prompt.
 */

export const EXPORT_KINDS = ["summary", "invoices", "payments", "pnl", "expenses"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** A plain decimal number, optionally negative — never a formula. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * RFC 4180 quoting. The leading-character guard stops spreadsheet apps
 * interpreting a field like "=1+1" or "+A1" as a formula when the file is
 * opened — a well-known CSV injection vector for exported customer names.
 *
 * Well-formed numbers are exempt. A negative money figure — a refund, or a
 * month that lost money — starts with "-" and would otherwise be escaped to
 * "'-2454.50", which Excel imports as TEXT: the accountant's column of figures
 * silently stops summing. "-2454.50" cannot be a formula, so nothing is given
 * up by letting it through.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const guarded = !NUMERIC.test(raw) && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function csvRows(rows: (string | number | null | undefined)[][]): string {
  // Excel on Windows needs CRLF and a BOM to read UTF-8 reliably.
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const money = (cents: number) => (cents / 100).toFixed(2);

function localDate(value: Date | null, timeZone: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

const percent = (rate: number | null) => (rate === null ? "" : (rate * 100).toFixed(1));

/** Headline numbers, one block per report section. */
function summaryCsv(snapshot: ReportingSnapshot): string {
  const rows: (string | number | null)[][] = [
    ["Report", `Last ${snapshot.window.days} days`],
    ["Timezone", snapshot.timezone],
    ["Currency", snapshot.currency],
    [],
    ["Revenue (cash basis)", ""],
    ["Gross received", money(snapshot.revenue.grossCents)],
    ["Refunded", money(snapshot.revenue.refundCents)],
    ["Net revenue", money(snapshot.revenue.netCents)],
    ["Payments", snapshot.revenue.paymentCount],
    ["Refunds", snapshot.revenue.refundCount],
    [],
    ["Tax (invoices issued)", ""],
    ["Invoices issued", snapshot.tax.invoiceCount],
    ["Taxable sales", money(snapshot.tax.taxableBaseCents)],
    ["Tax collected", money(snapshot.tax.taxCollectedCents)],
    ["Non-taxed invoices", snapshot.tax.exemptInvoiceCount],
    ["Non-taxed sales", money(snapshot.tax.exemptBaseCents)],
    [],
    ["Non-taxed reason", "Invoices", "Sales"],
    ...snapshot.tax.exemptReasons.map((r) => [r.reason, r.count, money(r.baseCents)]),
    [],
    ["Payment method", "Gross", "Refunded", "Net", "Payments"],
    ...snapshot.paymentMethods.map((m) => [
      PAYMENT_PROVIDER_LABELS[m.provider] ?? m.provider,
      money(m.grossCents),
      money(m.refundCents),
      money(m.netCents),
      m.count,
    ]),
    [],
    ["Source", "Gross", "Refunded", "Net"],
    ...snapshot.sourceRevenue.map((s) => [
      s.source,
      money(s.grossCents),
      money(s.refundCents),
      money(s.netCents),
    ]),
    [],
    ["Funnel stage", "Count", "Step rate %", "Overall rate %"],
    ...snapshot.funnel.stages.map((s) => [s.label, s.count, percent(s.stepRate), percent(s.overallRate)]),
    [],
    ["Bay", "Booked minutes", "Available minutes", "Utilization %"],
    ...snapshot.utilization.resources.map((r) => [
      r.name,
      r.bookedMinutes,
      r.availableMinutes,
      percent(r.utilizationRate),
    ]),
  ];
  return csvRows(rows);
}

/** One row per invoice issued in the window — the HST working paper. */
async function invoicesCsv(days: ReportDays, now: Date): Promise<string> {
  const settings = await getSettings();
  const window = getReportWindow(days, settings.timezone, now);
  const issuedInWindow = or(
    and(
      isNotNull(schema.invoices.invoiceDate),
      gte(schema.invoices.invoiceDate, window.start),
      lt(schema.invoices.invoiceDate, window.end),
    ),
    and(
      isNull(schema.invoices.invoiceDate),
      gte(schema.invoices.createdAt, window.start),
      lt(schema.invoices.createdAt, window.end),
    ),
  );

  const rows = await db()
    .select({
      number: schema.invoices.number,
      status: schema.invoices.status,
      invoiceDate: schema.invoices.invoiceDate,
      createdAt: schema.invoices.createdAt,
      subtotalCents: schema.invoices.subtotalCents,
      discountCents: schema.invoices.discountCents,
      taxCents: schema.invoices.taxCents,
      taxRateBp: schema.invoices.taxRateBp,
      taxExempt: schema.invoices.taxExempt,
      taxExemptReason: schema.invoices.taxExemptReason,
      totalCents: schema.invoices.totalCents,
      customerFirstName: schema.customers.firstName,
      customerLastName: schema.customers.lastName,
      companyName: schema.customers.companyName,
    })
    .from(schema.invoices)
    .leftJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
    .where(issuedInWindow)
    .orderBy(asc(schema.invoices.number));

  return csvRows([
    [
      "Invoice",
      "Date",
      "Status",
      "Customer",
      "Subtotal",
      "Discount",
      "Taxable base",
      "Tax rate %",
      "Tax",
      "Tax exempt",
      "Exemption reason",
      "Total",
    ],
    ...rows.map((r) => [
      `INV-${r.number}`,
      localDate(r.invoiceDate ?? r.createdAt, settings.timezone),
      r.status.replaceAll("_", " "),
      r.companyName || `${r.customerFirstName ?? ""} ${r.customerLastName ?? ""}`.trim(),
      money(r.subtotalCents),
      money(r.discountCents),
      money(r.subtotalCents - r.discountCents),
      (r.taxRateBp / 100).toFixed(2),
      money(r.taxCents),
      r.taxExempt ? "Yes" : "No",
      r.taxExemptReason ?? "",
      money(r.totalCents),
    ]),
  ]);
}

/** One row per payment received in the window — the cash reconciliation. */
async function paymentsCsv(days: ReportDays, now: Date): Promise<string> {
  const settings = await getSettings();
  const window = getReportWindow(days, settings.timezone, now);
  const receivedInWindow = or(
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

  const rows = await db()
    .select({
      receivedAt: schema.payments.receivedAt,
      createdAt: schema.payments.createdAt,
      provider: schema.payments.provider,
      kind: schema.payments.kind,
      status: schema.payments.status,
      amountCents: schema.payments.amountCents,
      invoiceNumber: schema.invoices.number,
    })
    .from(schema.payments)
    .leftJoin(schema.invoices, eq(schema.payments.invoiceId, schema.invoices.id))
    .where(receivedInWindow)
    .orderBy(asc(schema.payments.createdAt));

  return csvRows([
    ["Date", "Invoice", "Method", "Type", "Status", "Amount"],
    ...rows.map((r) => [
      localDate(r.receivedAt ?? r.createdAt, settings.timezone),
      r.invoiceNumber ? `INV-${r.invoiceNumber}` : "",
      PAYMENT_PROVIDER_LABELS[r.provider] ?? r.provider,
      r.kind,
      r.status,
      // Refunds are money out; sign them so a spreadsheet sum is the net.
      `${r.kind === "refund" ? "-" : ""}${money(r.amountCents)}`,
    ]),
  ]);
}

/**
 * Monthly profit and loss, laid out the way the tracker's Monthly Summary tab
 * was: sales, then expenses by category, then the bottom line. The accountant
 * already knows this shape, which is what makes the handover easy.
 */
function pnlCsv(books: BooksSnapshot, taxLabel: string): string {
  const rows: (string | number | null)[][] = [
    ["Profit & loss", books.period.label],
    ["Timezone", books.timezone],
    ["Currency", books.currency],
    ["Basis", "Sales: invoices issued. Expenses: date paid."],
    [],
    ["Sales", ""],
    ["Net sales (before tax)", money(books.pnl.netSalesCents)],
    [`${taxLabel} collected`, money(books.pnl.taxCollectedCents)],
    ["Gross invoiced", money(books.pnl.grossSalesCents)],
    ["Discounts given", money(books.pnl.discountsGivenCents)],
    ["Invoices issued", books.pnl.invoiceCount],
    [],
    ["Expenses by category", "Payments", `${taxLabel} paid`, "Amount"],
    ...books.pnl.expenses.byCategory.map((entry) => [
      entry.name,
      entry.count,
      money(entry.taxPaidCents),
      money(entry.amountCents),
    ]),
    ["Total expenses", books.pnl.expenses.count, money(books.pnl.expenses.inputTaxCreditCents), money(books.pnl.expenses.totalCents)],
    [],
    ["Bottom line", ""],
    ["Net profit", money(books.pnl.netProfitCents)],
    ["Profit margin %", percent(books.pnl.profitMargin)],
    [],
    [`${taxLabel} position`, ""],
    ["Collected on sales", money(books.tax.collectedCents)],
    ["Input credits on purchases", money(books.tax.inputCreditCents)],
    ["Net to remit", money(books.tax.netOwingCents)],
  ];

  if (books.priorYear) {
    rows.push(
      [],
      ["Compared with", books.priorYear.period.label],
      ["Net sales", money(books.priorYear.pnl.netSalesCents)],
      ["Expenses", money(books.priorYear.pnl.expenses.totalCents)],
      ["Net profit", money(books.priorYear.pnl.netProfitCents)],
    );
  }
  return csvRows(rows);
}

/** Every expense in the period, one row each — the Expenses tab, exported. */
async function expensesCsv(books: BooksSnapshot, taxLabel: string): Promise<string> {
  const period = getPeriodWindow(
    books.period.kind,
    books.period.year,
    books.period.index,
    books.timezone,
  );
  const rows = await listExpenses(period);
  return csvRows([
    ["Date", "Category", "Paid to", "Staff", "Description", "Reference", "Paid by", `${taxLabel} paid`, "Amount"],
    ...rows.map((row) => [
      localDate(row.expenseDate, books.timezone),
      row.categoryName,
      row.paidTo ?? "",
      row.staffName ?? "",
      row.description ?? "",
      row.reference ?? "",
      row.paidBy,
      money(row.taxPaidCents),
      money(row.amountCents),
    ]),
  ]);
}

export async function buildReportCsv(
  kind: ExportKind,
  days: ReportDays,
  snapshot: ReportingSnapshot,
  now = new Date(),
  books?: BooksSnapshot,
): Promise<string> {
  if (kind === "summary") return summaryCsv(snapshot);
  if (kind === "invoices") return invoicesCsv(days, now);
  if (kind === "payments") return paymentsCsv(days, now);

  if (!books) throw new Error(`The ${kind} export needs a books snapshot`);
  const settings = await getSettings();
  return kind === "pnl" ? pnlCsv(books, settings.taxLabel) : expensesCsv(books, settings.taxLabel);
}

export const BOOKS_EXPORT_KINDS: readonly ExportKind[] = ["pnl", "expenses"];

/** Narrows an unvalidated query value to a period kind. */
export function parsePeriodKind(value: string | null): PeriodKind {
  return value === "quarter" || value === "year" ? value : "month";
}
