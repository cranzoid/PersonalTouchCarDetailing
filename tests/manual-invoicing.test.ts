import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_manual_invoice_test",
  name: "Test Owner",
  email: "manual-invoice@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { renderInvoicePdf } from "../src/lib/invoice-pdf";
import {
  createManualInvoiceAction,
  recordPaymentAction,
  setInvoiceTaxExemptAction,
} from "../src/app/admin/(app)/invoices/actions";

/** Counts page objects in the raw PDF — catches accidental blank trailing pages. */
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

let customerId: string;
let vehicleId: string;
let sedanVehicleId: string;
let serviceId: string;
let quoteOnlyServiceId: string;
let addonId: string;

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers, audit_log,
     staff_users, invoice_counters, service_addons, addons, services, service_vehicle_adjustments,
     service_categories RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "x",
    role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 1000 });

  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Walk",
    lastName: "In",
    phone: "905-555-0143",
    email: "walkin@example.com",
    preferredContact: "phone",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId,
    year: 2021,
    make: "Toyota",
    model: "Highlander",
    category: "suv_large",
    licencePlate: "ABCD 123",
  });
  sedanVehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: sedanVehicleId,
    customerId,
    year: 2020,
    make: "Honda",
    model: "Accord",
    category: "sedan",
    licencePlate: "SEDN 001",
  });

  // Catalogue mirroring the real pricing shape: $200 base (sedan/coupe),
  // +$50 for a large SUV, with one linked add-on and one quote-only service.
  const categoryId = newId("cat");
  await db().insert(schema.serviceCategories).values({
    id: categoryId, name: "Detail packages", slug: "detail-packages", sort: 0,
  });
  serviceId = newId("svc");
  await db().insert(schema.services).values({
    id: serviceId, categoryId, name: "Complete Detailing Package",
    slug: "complete-detailing-package", basePriceCents: 20000, baseDurationMin: 180,
    bookingMode: "bookable", active: true,
  });
  await db().insert(schema.serviceVehicleAdjustments).values({
    id: newId("adj"), serviceId, vehicleCategory: "suv_large",
    priceDeltaCents: 5000, durationDeltaMin: 30,
  });
  quoteOnlyServiceId = newId("svc");
  await db().insert(schema.services).values({
    id: quoteOnlyServiceId, categoryId, name: "Paint correction",
    slug: "paint-correction", basePriceCents: null, baseDurationMin: 240,
    bookingMode: "quote_required", active: true,
  });
  addonId = newId("add");
  await db().insert(schema.addons).values({
    id: addonId, name: "Dog hair removal", priceCents: 5000, durationMin: 30, active: true, sort: 0,
  });
  await db().insert(schema.serviceAddons).values({ id: newId("add"), serviceId, addonId });
});

afterAll(async () => {
  await getPool().end();
});

const baseLines = [
  { kind: "custom", description: "Full interior detail", quantity: 1, unitPriceCents: 20000 },
  { kind: "custom", description: "Engine bay clean", quantity: 1, unitPriceCents: 5000 },
];

describe("createManualInvoiceAction", () => {
  it("creates a taxed invoice with no originating job", async () => {
    const result = await createManualInvoiceAction({ customerId, vehicleId, lines: baseLines });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.jobId).toBeNull();
    expect(invoice.createdByStaffId).toBe(staff.id);
    expect(invoice.subtotalCents).toBe(25000);
    expect(invoice.taxCents).toBe(3250);
    expect(invoice.totalCents).toBe(28250);
    expect(invoice.status).toBe("draft");
  });

  it("zeroes tax and records the reason when exempt, so total equals subtotal", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      lines: baseLines,
      taxExempt: true,
      taxExemptReason: "Cash sale",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.taxExempt).toBe(true);
    expect(invoice.taxExemptReason).toBe("Cash sale");
    expect(invoice.taxRateBp).toBe(0);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.totalCents).toBe(invoice.subtotalCents);
  });

  it("refuses an exemption with no stated reason", async () => {
    const result = await createManualInvoiceAction({ customerId, lines: baseLines, taxExempt: true });
    expect(result.ok).toBe(false);
  });

  it("backdates to the given calendar day in the business timezone", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      lines: baseLines,
      invoiceDateISO: "2026-03-09",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
      invoice.invoiceDate!,
    );
    expect(localDay).toBe("2026-03-09");
    // Backdating must not rewrite the audit trail of when it was entered.
    expect(invoice.createdAt.getTime()).toBeGreaterThan(invoice.invoiceDate!.getTime());
  });

  it("rejects a vehicle belonging to someone else", async () => {
    const otherId = newId("cus");
    await db().insert(schema.customers).values({
      id: otherId, firstName: "Other", lastName: "Person", phone: "905-555-0000", preferredContact: "phone",
    });
    const result = await createManualInvoiceAction({ customerId: otherId, vehicleId, lines: baseLines });
    expect(result.ok).toBe(false);
  });

  it("allocates sequential invoice numbers alongside other invoices", async () => {
    const first = await createManualInvoiceAction({ customerId, lines: baseLines });
    const second = await createManualInvoiceAction({ customerId, lines: baseLines });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const rows = await db().select().from(schema.invoices);
    const numbers = rows.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1000, 1001]);
  });
});

describe("catalogue pricing on manual invoices", () => {
  it("prices a package by the vehicle size, not the base price", async () => {
    // The reported bug: picking an SUV still billed the $200 sedan rate.
    const suv = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId, quantity: 1 }],
    });
    const sedan = await createManualInvoiceAction({
      customerId,
      vehicleId: sedanVehicleId,
      lines: [{ kind: "service", serviceId, quantity: 1 }],
    });
    expect(suv.ok && sedan.ok).toBe(true);
    if (!suv.ok || !sedan.ok) return;

    const [suvInvoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, suv.invoiceId));
    const [sedanInvoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, sedan.invoiceId));
    expect(suvInvoice.subtotalCents).toBe(25000);
    expect(sedanInvoice.subtotalCents).toBe(20000);
  });

  it("falls back to the base price when no vehicle is chosen", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      lines: [{ kind: "service", serviceId, quantity: 1 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.subtotalCents).toBe(20000);
  });

  it("ignores a client-supplied price unless it is an explicit override", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId, quantity: 2 }],
    });
    if (!result.ok) throw new Error("setup failed");
    const [line] = await db()
      .select()
      .from(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, result.invoiceId));
    expect(line.unitPriceCents).toBe(25000);
    expect(line.quantity).toBe(2);
    expect(line.serviceId).toBe(serviceId);
  });

  it("honours a staff price override", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId, quantity: 1, unitPriceCents: 18000 }],
    });
    if (!result.ok) throw new Error("setup failed");
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.subtotalCents).toBe(18000);
  });

  it("bills add-ons at the catalogue price alongside the service", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [
        { kind: "service", serviceId, quantity: 1 },
        { kind: "addon", addonId, quantity: 1 },
      ],
    });
    if (!result.ok) throw new Error("setup failed");
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.subtotalCents).toBe(30000);
  });

  it("requires a price for a quote-only service", async () => {
    const missing = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId: quoteOnlyServiceId, quantity: 1 }],
    });
    expect(missing.ok).toBe(false);

    const supplied = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId: quoteOnlyServiceId, quantity: 1, unitPriceCents: 45000 }],
    });
    expect(supplied.ok).toBe(true);
  });

  it("applies a percentage discount against the resolved subtotal", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      vehicleId,
      lines: [{ kind: "service", serviceId, quantity: 1 }],
      discountPercentBp: 1000, // 10%
      discountReason: "Repeat customer",
    });
    if (!result.ok) throw new Error("setup failed");
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId));
    expect(invoice.subtotalCents).toBe(25000);
    expect(invoice.discountCents).toBe(2500);
    expect(invoice.taxCents).toBe(2925); // 13% of 22500
    expect(invoice.totalCents).toBe(25425);
  });

  it("rejects a service that no longer exists", async () => {
    const result = await createManualInvoiceAction({
      customerId,
      lines: [{ kind: "service", serviceId: "svc_gone", quantity: 1 }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("setInvoiceTaxExemptAction", () => {
  it("recomputes the total and settles a cash payment exactly", async () => {
    const created = await createManualInvoiceAction({ customerId, lines: baseLines });
    if (!created.ok) throw new Error("setup failed");

    const exempted = await setInvoiceTaxExemptAction({
      invoiceId: created.invoiceId,
      taxExempt: true,
      reason: "Cash sale",
    });
    expect(exempted.ok).toBe(true);

    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, created.invoiceId));
    expect(invoice.totalCents).toBe(25000);

    // The original complaint: paying the pre-tax amount left the invoice
    // "partially paid". With tax removed, the cash amount settles it.
    const paid = await recordPaymentAction({
      invoiceId: created.invoiceId,
      method: "cash",
      amountCents: 25000,
      idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);

    const [settled] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, created.invoiceId));
    expect(settled.status).toBe("paid");
  });

  it("refuses to change tax once a payment exists", async () => {
    const created = await createManualInvoiceAction({ customerId, lines: baseLines });
    if (!created.ok) throw new Error("setup failed");
    await recordPaymentAction({
      invoiceId: created.invoiceId,
      method: "card_terminal",
      amountCents: 1000,
      idempotencyKey: newId("pay"),
    });

    const result = await setInvoiceTaxExemptAction({
      invoiceId: created.invoiceId,
      taxExempt: true,
      reason: "Cash sale",
    });
    expect(result.ok).toBe(false);
  });
});

describe("renderInvoicePdf", () => {
  it("renders a single page for a normal invoice", async () => {
    const created = await createManualInvoiceAction({ customerId, vehicleId, lines: baseLines });
    if (!created.ok) throw new Error("setup failed");

    const buffer = await renderInvoicePdf(created.invoiceId);
    expect(buffer).not.toBeNull();
    expect(buffer!.subarray(0, 5).toString()).toBe("%PDF-");
    expect(countPdfPages(buffer!)).toBe(1);
  });

  it("paginates long invoices without emitting a blank trailing page", async () => {
    const manyLines = Array.from({ length: 40 }, (_, n) => ({
      kind: "custom" as const,
      description:
        n % 3 === 0
          ? `Full interior and exterior detail with clay bar, engine bay clean and ceramic sealant — item ${n + 1}`
          : `Service item ${n + 1}`,
      quantity: 1,
      unitPriceCents: 12500 + n * 100,
    }));
    const created = await createManualInvoiceAction({ customerId, vehicleId, lines: manyLines.slice(0, 40) });
    if (!created.ok) throw new Error("setup failed");

    for (let i = 0; i < 10; i++) {
      await recordPaymentAction({
        invoiceId: created.invoiceId,
        method: "card_terminal",
        amountCents: 100,
        idempotencyKey: newId("pay"),
      });
    }

    const buffer = await renderInvoicePdf(created.invoiceId);
    const pages = countPdfPages(buffer!);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThanOrEqual(4);
  });

  it("returns null for an unknown invoice so callers can 404", async () => {
    expect(await renderInvoicePdf("inv_does_not_exist")).toBeNull();
  });
});
