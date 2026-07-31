import { readFileSync } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { PAYMENT_PROVIDER_LABELS } from "@/lib/payment-labels";
import { getSettings } from "@/lib/settings";
import { summarizePayments } from "@/lib/invoices";

/* ------------------------------------------------------------------ */
/* Layout constants                                                    */
/* ------------------------------------------------------------------ */

const PAGE = { width: 612, height: 792 };
const MARGIN = 48;
const CONTENT_RIGHT = PAGE.width - MARGIN;
const BAND_HEIGHT = 118;

const COLOURS = {
  brand: "#0B2A4A",
  accent: "#E0A93B",
  text: "#1C2026",
  muted: "#6B7785",
  hairline: "#DCE4EB",
  zebra: "#F6F8FA",
  onBrand: "#FFFFFF",
};

const COLUMNS = { desc: MARGIN, qty: 348, unit: 400, amount: 472 };
const COLUMN_WIDTH = { qty: 40, unit: 60, amount: CONTENT_RIGHT - COLUMNS.amount };

/**
 * Read once at module scope — the logo is small and immutable, and re-reading
 * it per request would add disk IO to every invoice download. A missing file
 * must never break invoicing, so failure degrades to a text wordmark.
 */
const LOGO = (() => {
  try {
    return readFileSync(path.join(process.cwd(), "public", "brand", "personal-touch-logo.png"));
  } catch {
    console.error("[invoice-pdf] brand logo missing — falling back to a text wordmark");
    return null;
  }
})();

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Renders an invoice to a PDF buffer.
 *
 * Nothing here recomputes money: the invoice row is an immutable snapshot of
 * what was charged (including its tax rate and registration number at the time
 * of issue), and this only lays out what is stored. Returns null when the
 * invoice does not exist so callers can 404.
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

  // bottom: 0 disables pdfkit's automatic page breaks. This module positions
  // every block explicitly and calls ensureSpace() to paginate, so leaving the
  // automatic behaviour on made pdfkit insert a second page whenever a write
  // landed near the margin — including the footer itself.
  const doc = new PDFDocument({
    size: "letter",
    margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const money = (cents: number) => formatCents(cents, settings.currency);
  const date = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(value);

  drawHeaderBand(doc, invoice, settings, date);
  let y = BAND_HEIGHT + 28;
  y = drawParties(doc, y, { invoice, customer, vehicle, settings, date });
  y = drawLineItems(doc, y, lines, money);
  y = drawTotals(doc, y, invoice, summary, money);
  if (payments.length > 0) y = drawPaymentHistory(doc, y, payments, money, date);
  if (invoice.notes) drawNotes(doc, y, invoice.notes);

  drawFooters(doc, settings);
  doc.end();
  return done;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

type Settings = Awaited<ReturnType<typeof getSettings>>;
type Invoice = typeof schema.invoices.$inferSelect;

/** Trade name leads; the legal entity and HST number sit in the same block. */
function drawHeaderBand(doc: Doc, invoice: Invoice, settings: Settings, date: (d: Date) => string) {
  doc.rect(0, 0, PAGE.width, BAND_HEIGHT).fill(COLOURS.brand);
  doc.rect(0, BAND_HEIGHT, PAGE.width, 3).fill(COLOURS.accent);

  let textLeft = MARGIN;
  if (LOGO) {
    // The crest is navy-and-gold on transparency, so its wordmark vanishes
    // against the navy band. Sit it on a white chip instead of recolouring it.
    const logoHeight = 62;
    const logoWidth = Math.round((948 / 1074) * logoHeight);
    const pad = 7;
    const chipWidth = logoWidth + pad * 2;
    const chipHeight = logoHeight + pad * 2;
    const chipY = Math.round((BAND_HEIGHT - chipHeight) / 2);
    doc.roundedRect(MARGIN, chipY, chipWidth, chipHeight, 6).fill(COLOURS.onBrand);
    doc.image(LOGO, MARGIN + pad, chipY + pad, { height: logoHeight });
    textLeft = MARGIN + chipWidth + 14;
  }

  doc
    .fillColor(COLOURS.onBrand)
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(settings.businessName.toUpperCase(), textLeft, 26, { width: 300, lineGap: 1 });

  const identity = [
    `${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`,
    `${settings.phone}  ·  ${settings.email}`,
    settings.legalEntityName ? `Operated by ${settings.legalEntityName}` : null,
    invoice.taxRegistrationNumber ? `${invoice.taxLabel} No. ${invoice.taxRegistrationNumber}` : null,
  ].filter(Boolean) as string[];

  doc.font("Helvetica").fontSize(7.5).fillColor("#C9D6E3");
  let identityY = doc.y + 3;
  for (const row of identity) {
    doc.text(row, textLeft, identityY, { width: 300 });
    identityY = doc.y;
  }

  // Invoice identity, right-aligned against the same band.
  const boxLeft = 380;
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(COLOURS.onBrand)
    .text("INVOICE", boxLeft, 26, { width: CONTENT_RIGHT - boxLeft, align: "right" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLOURS.accent)
    .text(`INV-${invoice.number}`, boxLeft, doc.y + 2, { width: CONTENT_RIGHT - boxLeft, align: "right" });

  const issued = invoice.invoiceDate ?? invoice.createdAt;
  const meta = [
    `Date: ${date(issued)}`,
    invoice.dueAt ? `Due: ${date(invoice.dueAt)}` : null,
    `Status: ${invoice.status.replaceAll("_", " ")}`,
  ].filter(Boolean) as string[];
  doc.fontSize(7.5).fillColor("#C9D6E3");
  let metaY = doc.y + 4;
  for (const row of meta) {
    doc.text(row, boxLeft, metaY, { width: CONTENT_RIGHT - boxLeft, align: "right" });
    metaY = doc.y;
  }
}

function drawParties(
  doc: Doc,
  y: number,
  ctx: {
    invoice: Invoice;
    customer?: typeof schema.customers.$inferSelect;
    vehicle?: typeof schema.vehicles.$inferSelect;
    settings: Settings;
    date: (d: Date) => string;
  },
): number {
  const { customer, vehicle, invoice } = ctx;
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(COLOURS.muted)
    .text("BILL TO", MARGIN, y, { characterSpacing: 0.6 });

  const bodyY = doc.y + 4;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOURS.text);
  if (customer) {
    const name =
      customer.customerType === "business" && customer.companyName
        ? customer.companyName
        : `${customer.firstName} ${customer.lastName}`.trim();
    doc.text(name, MARGIN, bodyY, { width: 260 });
    doc.font("Helvetica").fontSize(9).fillColor(COLOURS.muted);
    if (customer.customerType === "business" && customer.companyName) {
      doc.text(`${customer.firstName} ${customer.lastName}`.trim(), { width: 260 });
    }
    if (customer.email) doc.text(customer.email, { width: 260 });
    if (customer.phone) doc.text(customer.phone, { width: 260 });
  } else {
    doc.text("—", MARGIN, bodyY);
  }
  const leftBottom = doc.y;

  if (vehicle) {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(COLOURS.muted)
      .text("VEHICLE", 348, y, { characterSpacing: 0.6, width: CONTENT_RIGHT - 348 });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLOURS.text)
      .text([vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" "), 348, bodyY, {
        width: CONTENT_RIGHT - 348,
      });
    if (vehicle.licencePlate) {
      doc.fillColor(COLOURS.muted).text(vehicle.licencePlate, { width: CONTENT_RIGHT - 348 });
    }
  }

  // Exemption is stated up front — it is the first thing a reviewer looks for.
  let next = Math.max(leftBottom, doc.y) + 18;
  if (invoice.taxExempt) {
    const label = `No ${invoice.taxLabel} charged${invoice.taxExemptReason ? ` — ${invoice.taxExemptReason}` : ""}`;
    const height = doc.heightOfString(label, { width: PAGE.width - MARGIN * 2 - 20 }) + 12;
    doc.rect(MARGIN, next, PAGE.width - MARGIN * 2, height).fill("#FDF6E7");
    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor("#8A6316")
      .text(label, MARGIN + 10, next + 6, { width: PAGE.width - MARGIN * 2 - 20 });
    next += height + 14;
  }
  return next;
}

function drawLineItems(
  doc: Doc,
  startY: number,
  lines: (typeof schema.invoiceLineItems.$inferSelect)[],
  money: (c: number) => string,
): number {
  let y = ensureSpace(doc, startY, 60);

  doc.rect(MARGIN, y, PAGE.width - MARGIN * 2, 22).fill(COLOURS.brand);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOURS.onBrand);
  const headerY = y + 7.5;
  doc.text("DESCRIPTION", COLUMNS.desc + 10, headerY, { characterSpacing: 0.5 });
  doc.text("QTY", COLUMNS.qty, headerY, { width: COLUMN_WIDTH.qty, align: "right" });
  doc.text("UNIT", COLUMNS.unit, headerY, { width: COLUMN_WIDTH.unit, align: "right" });
  doc.text("AMOUNT", COLUMNS.amount, headerY, { width: COLUMN_WIDTH.amount - 10, align: "right" });
  y += 22;

  doc.font("Helvetica").fontSize(9.5);
  lines.forEach((line, index) => {
    const textHeight = doc.heightOfString(line.description, { width: 270 });
    const rowHeight = Math.max(textHeight + 12, 26);
    y = ensureSpace(doc, y, rowHeight);

    if (index % 2 === 1) {
      doc.rect(MARGIN, y, PAGE.width - MARGIN * 2, rowHeight).fill(COLOURS.zebra);
    }
    const textY = y + 7;
    doc.fillColor(COLOURS.text).text(line.description, COLUMNS.desc + 10, textY, { width: 270 });
    doc.text(String(line.quantity), COLUMNS.qty, textY, { width: COLUMN_WIDTH.qty, align: "right" });
    doc.text(money(line.unitPriceCents), COLUMNS.unit, textY, { width: COLUMN_WIDTH.unit, align: "right" });
    doc.text(money(line.quantity * line.unitPriceCents), COLUMNS.amount, textY, {
      width: COLUMN_WIDTH.amount - 10,
      align: "right",
    });
    y += rowHeight;
  });

  doc.moveTo(MARGIN, y).lineTo(CONTENT_RIGHT, y).lineWidth(0.5).strokeColor(COLOURS.hairline).stroke();
  return y + 16;
}

function drawTotals(
  doc: Doc,
  startY: number,
  invoice: Invoice,
  summary: ReturnType<typeof summarizePayments>,
  money: (c: number) => string,
): number {
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: "Subtotal", value: money(invoice.subtotalCents) },
  ];
  if (invoice.discountCents > 0) rows.push({ label: "Discount", value: `-${money(invoice.discountCents)}` });
  rows.push({
    label: invoice.taxExempt ? `${invoice.taxLabel} — exempt` : `${invoice.taxLabel} (${(invoice.taxRateBp / 100).toFixed(2)}%)`,
    value: money(invoice.taxCents),
  });
  rows.push({ label: "Total", value: money(invoice.totalCents), strong: true });
  if (invoice.depositAppliedCents > 0) {
    rows.push({ label: "Deposit applied", value: `-${money(invoice.depositAppliedCents)}` });
  }
  if (summary.paidCents > 0) rows.push({ label: "Paid", value: `-${money(summary.paidCents)}` });
  if (summary.refundedCents > 0) rows.push({ label: "Refunded", value: `+${money(summary.refundedCents)}` });

  const panelLeft = 330;
  const panelHeight = rows.length * 17 + 40;
  let y = ensureSpace(doc, startY, panelHeight);

  doc.rect(panelLeft, y, CONTENT_RIGHT - panelLeft, panelHeight).fill(COLOURS.zebra);
  let rowY = y + 12;
  for (const row of rows) {
    doc
      .font(row.strong ? "Helvetica-Bold" : "Helvetica")
      .fontSize(row.strong ? 10 : 9)
      .fillColor(row.strong ? COLOURS.text : COLOURS.muted)
      .text(row.label, panelLeft + 12, rowY, { width: 110, align: "left" });
    doc
      .fillColor(COLOURS.text)
      .text(row.value, panelLeft + 122, rowY, { width: CONTENT_RIGHT - panelLeft - 134, align: "right" });
    rowY += 17;
  }

  // Balance due gets its own emphasised strip — it is what the customer acts on.
  const balanceY = rowY + 2;
  doc.rect(panelLeft, balanceY, CONTENT_RIGHT - panelLeft, 26).fill(COLOURS.brand);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(COLOURS.onBrand)
    .text("Balance due", panelLeft + 12, balanceY + 8, { width: 110 });
  doc.text(money(summary.balanceCents), panelLeft + 122, balanceY + 8, {
    width: CONTENT_RIGHT - panelLeft - 134,
    align: "right",
  });

  return balanceY + 26 + 22;
}

function drawPaymentHistory(
  doc: Doc,
  startY: number,
  payments: (typeof schema.payments.$inferSelect)[],
  money: (c: number) => string,
  date: (d: Date) => string,
): number {
  let y = ensureSpace(doc, startY, 60);
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(COLOURS.muted)
    .text("PAYMENT HISTORY", MARGIN, y, { characterSpacing: 0.6 });
  y = doc.y + 6;
  doc.moveTo(MARGIN, y).lineTo(CONTENT_RIGHT, y).lineWidth(0.5).strokeColor(COLOURS.hairline).stroke();
  y += 8;

  doc.font("Helvetica").fontSize(8.5);
  for (const payment of payments) {
    y = ensureSpace(doc, y, 16);
    doc.fillColor(COLOURS.text).text(date(payment.receivedAt ?? payment.createdAt), MARGIN, y, { width: 110 });
    doc.text(PAYMENT_PROVIDER_LABELS[payment.provider] ?? payment.provider, 168, y, { width: 130 });
    doc
      .fillColor(COLOURS.muted)
      .text(payment.kind.charAt(0).toUpperCase() + payment.kind.slice(1), 306, y, { width: 90 });
    doc
      .fillColor(COLOURS.text)
      .text(`${payment.kind === "refund" ? "-" : ""}${money(payment.amountCents)}`, COLUMNS.amount, y, {
        width: COLUMN_WIDTH.amount - 10,
        align: "right",
      });
    y += 16;
  }
  return y + 14;
}

function drawNotes(doc: Doc, startY: number, notes: string): void {
  const y = ensureSpace(doc, startY, 50);
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(COLOURS.muted)
    .text("NOTES", MARGIN, y, { characterSpacing: 0.6 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLOURS.text)
    .text(notes, MARGIN, doc.y + 4, { width: PAGE.width - MARGIN * 2 });
}

/**
 * Footers are stamped after the body so page numbers know the real total.
 * The previous implementation wrote at a fixed y=720, which pushed a blank
 * trailing page as soon as the payment history grew.
 */
function drawFooters(doc: Doc, settings: Settings): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = PAGE.height - 54;
    doc.moveTo(MARGIN, y).lineTo(CONTENT_RIGHT, y).lineWidth(0.5).strokeColor(COLOURS.hairline).stroke();
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(COLOURS.muted)
      .text(`Questions? Call ${settings.phone} or email ${settings.email}.`, MARGIN, y + 8, {
        width: PAGE.width - MARGIN * 2,
        align: "center",
        lineBreak: false,
      });
    if (range.count > 1) {
      doc.text(`Page ${i + 1} of ${range.count}`, MARGIN, y + 20, {
        width: PAGE.width - MARGIN * 2,
        align: "center",
        lineBreak: false,
      });
    }
  }
}

/** Starts a new page when `needed` points would cross the footer rule. */
function ensureSpace(doc: Doc, y: number, needed: number): number {
  if (y + needed <= PAGE.height - 72) return y;
  doc.addPage();
  return MARGIN;
}
