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

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers, audit_log,
     staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
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
});

afterAll(async () => {
  await getPool().end();
});

const baseLines = [
  { description: "Full interior detail", quantity: 1, unitPriceCents: 20000 },
  { description: "Engine bay clean", quantity: 1, unitPriceCents: 5000 },
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
      method: "cash",
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
        method: "cash",
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
