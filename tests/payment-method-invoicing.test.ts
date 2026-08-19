import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_payment_method_test",
  name: "Test Owner",
  email: "payment-method@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { summarizeTax } from "../src/lib/reporting";
import {
  createManualInvoiceAction,
  recordPaymentAction,
  setInvoiceTaxExemptAction,
} from "../src/app/admin/(app)/invoices/actions";
import {
  anonymizeCustomerAction,
  createCustomerAction,
  updateCustomerAction,
} from "../src/app/admin/(app)/customers/actions";

let customerId: string;

const lines = [{ kind: "custom" as const, description: "Package #2", quantity: 1, unitPriceCents: 17500 }];

async function loadInvoice(id: string) {
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, id));
  return invoice;
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers, leads,
     audit_log, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 2000 });
  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Pat", lastName: "Cash", phone: "(905) 555-0177", preferredContact: "phone",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("an invoice is raised WITH tax — the shop does not know how they will pay", () => {
  it("issues $175 of work at $197.75, tax on, no method bound to it", async () => {
    const created = await createManualInvoiceAction({ customerId, lines });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.subtotalCents).toBe(17500);
    expect(invoice.taxCents).toBe(2275);
    expect(invoice.totalCents).toBe(19775);
    expect(invoice.taxTreatment).toBe("added");
    expect(invoice.quotedPaymentMethod).toBeNull();
    expect(invoice.taxExempt).toBe(false);
  });

  it("still honours a staff exemption at creation, with no method bound", async () => {
    const created = await createManualInvoiceAction({
      customerId, lines, taxExempt: true, taxExemptReason: "Out-of-province customer",
    });
    if (!created.ok) throw new Error("setup failed");
    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.totalCents).toBe(17500);
    expect(invoice.taxTreatment).toBe("none");
    expect(invoice.quotedPaymentMethod).toBeNull();
  });
});

describe("recording the payment is what settles the tax", () => {
  async function issued() {
    const created = await createManualInvoiceAction({ customerId, lines });
    if (!created.ok) throw new Error("setup failed");
    await db().update(schema.invoices).set({ status: "sent" }).where(eq(schema.invoices.id, created.invoiceId));
    return created.invoiceId;
  }

  it("strips the tax and re-prices to $175.00 when they pay cash", async () => {
    const invoiceId = await issued();
    const paid = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);

    const invoice = await loadInvoice(invoiceId);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.taxRateBp).toBe(0);
    expect(invoice.totalCents).toBe(17500);
    expect(invoice.taxTreatment).toBe("none");
    expect(invoice.quotedPaymentMethod).toBe("cash");
    // The existing exempt pair is what the PDF and summarizeTax already read.
    expect(invoice.taxExempt).toBe(true);
    expect(invoice.taxExemptReason).toBe("Cash sale — no HST charged");
    expect(invoice.status).toBe("paid");
  });

  it("does the same for Interac e-transfer", async () => {
    const invoiceId = await issued();
    const paid = await recordPaymentAction({
      invoiceId, method: "etransfer", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);
    const invoice = await loadInvoice(invoiceId);
    expect(invoice.totalCents).toBe(17500);
    expect(invoice.taxExemptReason).toBe("Interac e-transfer sale — no HST charged");
  });

  it("keeps the tax and the $197.75 total when they pay by card or cheque", async () => {
    for (const method of ["card_terminal", "cheque"] as const) {
      const invoiceId = await issued();
      const paid = await recordPaymentAction({
        invoiceId, method, amountCents: 19775, idempotencyKey: newId("pay"),
      });
      expect(paid.ok).toBe(true);
      const invoice = await loadInvoice(invoiceId);
      expect(invoice.taxCents).toBe(2275);
      expect(invoice.totalCents).toBe(19775);
      expect(invoice.taxTreatment).toBe("added");
      expect(invoice.quotedPaymentMethod).toBe(method);
    }
  });

  it("refuses the taxed figure tendered in cash, and does not re-price on the way out", async () => {
    // Staff clicking "pay in full" before switching the method to cash would
    // otherwise strip $22.75 of tax and THEN reject the payment, leaving the
    // invoice re-priced by a payment that never happened.
    const invoiceId = await issued();
    const result = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 19775, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("$175.00");

    const invoice = await loadInvoice(invoiceId);
    expect(invoice.totalCents).toBe(19775);
    expect(invoice.taxTreatment).toBe("added");
    expect(invoice.quotedPaymentMethod).toBeNull();
    expect(await db().select().from(schema.payments)).toHaveLength(0);
  });

  it("settles the question on the FIRST payment and holds it there", async () => {
    const invoiceId = await issued();
    const first = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 10000, idempotencyKey: newId("pay"),
    });
    expect(first.ok).toBe(true);
    expect((await loadInvoice(invoiceId)).totalCents).toBe(17500);

    const blocked = await recordPaymentAction({
      invoiceId, method: "card_terminal", amountCents: 7500, idempotencyKey: newId("pay"),
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toContain("already part-paid");

    const rest = await recordPaymentAction({
      invoiceId, method: "etransfer", amountCents: 7500, idempotencyKey: newId("pay"),
    });
    expect(rest.ok).toBe(true);
    expect((await loadInvoice(invoiceId)).status).toBe("paid");
  });

  it("never re-prices an invoice that was already part-paid before the rule existed", async () => {
    const invoiceId = await issued();
    await recordPaymentAction({ invoiceId, method: "card_terminal", amountCents: 5000, idempotencyKey: newId("pay") });
    // Exactly the shape of a row migrated by 0008 mid-payment: a payment
    // against it, no quoted method.
    await db().update(schema.invoices).set({ quotedPaymentMethod: null })
      .where(eq(schema.invoices.id, invoiceId));

    const paid = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 14775, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);
    const invoice = await loadInvoice(invoiceId);
    expect(invoice.totalCents).toBe(19775);
    expect(invoice.taxCents).toBe(2275);
  });

  it("lets any method settle a staff-exempted invoice, and binds none of them", async () => {
    const created = await createManualInvoiceAction({
      customerId, lines, taxExempt: true, taxExemptReason: "Exempt organisation",
    });
    if (!created.ok) throw new Error("setup failed");
    await db().update(schema.invoices).set({ status: "sent" }).where(eq(schema.invoices.id, created.invoiceId));

    const paid = await recordPaymentAction({
      invoiceId: created.invoiceId, method: "card_terminal", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);
    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.taxExemptReason).toBe("Exempt organisation");
    expect(invoice.quotedPaymentMethod).toBeNull();
  });

  it("is idempotent — a retried payment does not re-price anything twice", async () => {
    const invoiceId = await issued();
    const key = newId("pay");
    const first = await recordPaymentAction({ invoiceId, method: "cash", amountCents: 17500, idempotencyKey: key });
    const retry = await recordPaymentAction({ invoiceId, method: "cash", amountCents: 17500, idempotencyKey: key });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(await db().select().from(schema.payments)).toHaveLength(1);
    expect((await loadInvoice(invoiceId)).totalCents).toBe(17500);
  });

  it("makes the restatement a query: none + a method finds the cash sales only", async () => {
    const cash = await issued();
    await recordPaymentAction({ invoiceId: cash, method: "cash", amountCents: 17500, idempotencyKey: newId("pay") });
    const card = await issued();
    await recordPaymentAction({ invoiceId: card, method: "cheque", amountCents: 19775, idempotencyKey: newId("pay") });
    const staffExempt = await createManualInvoiceAction({
      customerId, lines, taxExempt: true, taxExemptReason: "Out-of-province customer",
    });
    if (!staffExempt.ok) throw new Error("setup failed");

    const all = await db().select().from(schema.invoices);
    const restatable = all.filter((i) => i.taxTreatment === "none" && i.quotedPaymentMethod !== null);
    expect(restatable).toHaveLength(1);
    expect(restatable[0]!.id).toBe(cash);
  });

  it("separates cash from e-transfer on the tax report's exempt-reason table", async () => {
    for (const method of ["cash", "cash", "etransfer"] as const) {
      const invoiceId = await issued();
      await recordPaymentAction({ invoiceId, method, amountCents: 17500, idempotencyKey: newId("pay") });
    }
    const summary = summarizeTax(await db().select().from(schema.invoices));
    expect(summary.taxCollectedCents).toBe(0);
    expect(summary.exemptReasons.map((r) => [r.reason, r.count])).toEqual([
      ["Cash sale — no HST charged", 2],
      ["Interac e-transfer sale — no HST charged", 1],
    ]);
  });
});

describe("discount reason", () => {
  it("takes a discount with no explanation at all — the owner does not record one", async () => {
    const result = await createManualInvoiceAction({ customerId, lines, discountCents: 2500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invoice = await loadInvoice(result.invoiceId);
    expect(invoice.discountCents).toBe(2500);
    expect(invoice.discountReason).toBeNull();
    expect(invoice.totalCents).toBe(16950); // 150.00 + 13% HST
  });

  it("still stores the reason when one is given", async () => {
    const result = await createManualInvoiceAction({
      customerId, lines, discountCents: 2500, discountReason: "Service recovery",
    });
    if (!result.ok) throw new Error("setup failed");
    const invoice = await loadInvoice(result.invoiceId);
    expect(invoice.discountCents).toBe(2500);
    expect(invoice.discountReason).toBe("Service recovery");
  });

  it("accepts a zero discount unchanged", async () => {
    const result = await createManualInvoiceAction({ customerId, lines, discountPercentBp: 0 });
    expect(result.ok).toBe(true);
  });
});

describe("phone normalization is written on the staff customer paths", () => {
  it("stores bare digits alongside the number exactly as the customer gave it", async () => {
    const created = await createCustomerAction({
      firstName: "Sam",
      lastName: "Reid",
      phone: "+1 (905) 555-0199",
      preferredContact: "phone",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [customer] = await db().select().from(schema.customers)
      .where(eq(schema.customers.id, created.customerId));
    expect(customer.phone).toBe("+1 (905) 555-0199");
    expect(customer.phoneNormalized).toBe("9055550199");
  });

  it("re-derives it on edit, so a corrected number stays findable", async () => {
    const created = await createCustomerAction({
      firstName: "Sam", lastName: "Reid", phone: "905-555-0199", preferredContact: "phone",
    });
    if (!created.ok) throw new Error("setup failed");
    const updated = await updateCustomerAction({
      customerId: created.customerId,
      firstName: "Sam",
      lastName: "Reid",
      phone: "(905) 555-0200",
      preferredContact: "phone",
      customerType: "individual",
      tags: [],
      marketingConsent: false,
    });
    expect(updated.ok).toBe(true);
    const [customer] = await db().select().from(schema.customers)
      .where(eq(schema.customers.id, created.customerId));
    expect(customer.phoneNormalized).toBe("9055550200");
  });

  it("clears it on anonymization — it is personal data like the number itself", async () => {
    const created = await createCustomerAction({
      firstName: "Sam", lastName: "Reid", phone: "905-555-0199", preferredContact: "phone",
    });
    if (!created.ok) throw new Error("setup failed");
    const result = await anonymizeCustomerAction({
      customerId: created.customerId,
      confirmation: "ANONYMIZE",
      reason: "Customer exercised their right to erasure",
    });
    expect(result.ok).toBe(true);
    const [customer] = await db().select().from(schema.customers)
      .where(eq(schema.customers.id, created.customerId));
    expect(customer.phone).toBeNull();
    expect(customer.phoneNormalized).toBeNull();
  });
});
