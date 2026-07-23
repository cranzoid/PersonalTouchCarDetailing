import PDFDocument from "pdfkit";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { summarizePayments } from "@/lib/invoices";

const PROVIDER_LABELS: Record<string, string> = {
  fake: "Test payment",
  stripe: "Card",
  cash: "Cash",
  etransfer: "E-transfer",
  card_terminal: "Card terminal",
};

/**
 * Renders an invoice to a PDF buffer using the same totals/payment-summary
 * logic as the admin and portal invoice pages (nothing here recomputes
 * money — it only lays out what's already stored/derived). Returns null if
 * the invoice doesn't exist so callers can 404.
 */
export async function renderInvoicePdf(invoiceId: string): Promise<Buffer | null> {
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
  if (!invoice) return null;

  const settings = await getSettings();
  const [customer] = await db()
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, invoice.customerId))
    .limit(1);
  const vehicle = invoice.vehicleId
    ? (await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, invoice.vehicleId)).limit(1))[0]
    : undefined;
  const lines = await db()
    .select()
    .from(schema.invoiceLineItems)
    .where(eq(schema.invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLineItems.sort));
  const payments = await db()
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId))
    .orderBy(desc(schema.payments.createdAt));
  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);

  const doc = new PDFDocument({ size: "letter", margin: 50 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const money = (cents: number) => formatCents(cents, settings.currency);

  // Header
  doc.fontSize(18).text(settings.businessName, { continued: false });
  doc
    .fontSize(9)
    .fillColor("#555555")
    .text(`${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`)
    .text(`${settings.phone} · ${settings.email}`);
  if (invoice.taxRegistrationNumber) {
    doc.text(`${invoice.taxLabel} #: ${invoice.taxRegistrationNumber}`);
  }
  doc.fillColor("#000000");

  doc.moveDown(1);
  doc.fontSize(20).text(`INVOICE INV-${invoice.number}`, { align: "right" });
  doc
    .fontSize(10)
    .fillColor("#555555")
    .text(`Status: ${invoice.status.replaceAll("_", " ")}`, { align: "right" })
    .text(`Created: ${invoice.createdAt.toLocaleDateString("en-CA")}`, { align: "right" });
  if (invoice.dueAt) doc.text(`Due: ${invoice.dueAt.toLocaleDateString("en-CA")}`, { align: "right" });
  doc.fillColor("#000000");

  // Bill to
  doc.moveDown(1.5);
  doc.fontSize(11).text("Bill to", { underline: true });
  doc.fontSize(10);
  if (customer) {
    doc.text(`${customer.firstName} ${customer.lastName}`);
    if (customer.email) doc.text(customer.email);
    if (customer.phone) doc.text(customer.phone);
  }
  if (vehicle) {
    doc.text([vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" "));
  }

  // Line items table
  doc.moveDown(1.5);
  const tableTop = doc.y;
  const col = { desc: 50, qty: 340, unit: 400, amount: 470 };
  doc.fontSize(9).fillColor("#555555");
  doc.text("Item", col.desc, tableTop);
  doc.text("Qty", col.qty, tableTop, { width: 40, align: "right" });
  doc.text("Unit", col.unit, tableTop, { width: 60, align: "right" });
  doc.text("Amount", col.amount, tableTop, { width: 90, align: "right" });
  doc
    .moveTo(50, tableTop + 14)
    .lineTo(562, tableTop + 14)
    .strokeColor("#cccccc")
    .stroke();
  doc.fillColor("#000000").fontSize(10);

  let y = tableTop + 20;
  for (const l of lines) {
    const rowHeight = doc.heightOfString(l.description, { width: 280 }) + 6;
    doc.text(l.description, col.desc, y, { width: 280 });
    doc.text(String(l.quantity), col.qty, y, { width: 40, align: "right" });
    doc.text(money(l.unitPriceCents), col.unit, y, { width: 60, align: "right" });
    doc.text(money(l.quantity * l.unitPriceCents), col.amount, y, { width: 90, align: "right" });
    y += rowHeight;
  }
  doc
    .moveTo(50, y)
    .lineTo(562, y)
    .strokeColor("#cccccc")
    .stroke();
  y += 10;

  const totalsRow = (label: string, value: string, opts: { bold?: boolean } = {}) => {
    doc.fontSize(opts.bold ? 11 : 10);
    if (opts.bold) doc.font("Helvetica-Bold");
    doc.text(label, 340, y, { width: 130, align: "right" });
    doc.text(value, col.amount, y, { width: 90, align: "right" });
    if (opts.bold) doc.font("Helvetica");
    y += opts.bold ? 18 : 14;
  };

  totalsRow("Subtotal", money(invoice.subtotalCents));
  if (invoice.discountCents > 0) totalsRow("Discount", `−${money(invoice.discountCents)}`);
  totalsRow(`${invoice.taxLabel} (${(invoice.taxRateBp / 100).toFixed(2)}%)`, money(invoice.taxCents));
  totalsRow("Total", money(invoice.totalCents), { bold: true });
  if (invoice.depositAppliedCents > 0) totalsRow("Deposit applied", `−${money(invoice.depositAppliedCents)}`);
  if (summary.paidCents > 0) totalsRow("Paid", `−${money(summary.paidCents)}`);
  if (summary.refundedCents > 0) totalsRow("Refunded", `+${money(summary.refundedCents)}`);
  totalsRow("Balance due", money(summary.balanceCents), { bold: true });

  // Payment history
  if (payments.length > 0) {
    y += 16;
    doc.fontSize(11).text("Payment history", 50, y, { underline: true });
    y += 18;
    doc.fontSize(9).fillColor("#555555");
    doc.text("Date", 50, y);
    doc.text("Method", 180, y);
    doc.text("Kind", 320, y);
    doc.text("Amount", col.amount, y, { width: 90, align: "right" });
    y += 14;
    doc.fillColor("#000000").fontSize(9);
    for (const p of payments) {
      const date = (p.receivedAt ?? p.createdAt).toLocaleDateString("en-CA");
      doc.text(date, 50, y);
      doc.text(PROVIDER_LABELS[p.provider] ?? p.provider, 180, y);
      doc.text(p.kind, 320, y);
      doc.text(`${p.kind === "refund" ? "−" : ""}${money(p.amountCents)}`, col.amount, y, { width: 90, align: "right" });
      y += 14;
    }
  }

  // Fixed position, but must stay clear of the 50pt bottom margin (792pt
  // page height) or pdfkit silently starts a second, otherwise-blank page.
  doc
    .fontSize(8)
    .fillColor("#999999")
    .text(`Questions? Call ${settings.phone} or email ${settings.email}.`, 50, 720, { width: 512, align: "center" });

  doc.end();
  return done;
}
