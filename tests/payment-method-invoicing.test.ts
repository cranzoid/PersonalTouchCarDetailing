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
  cancelInvoiceAction,
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

describe("the payment method decides whether the invoice charges tax", () => {
  it("records a cash sale at the listed price, with no tax and an auditable reason", async () => {
    const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: "cash" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.subtotalCents).toBe(17500);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.totalCents).toBe(17500);
    expect(invoice.taxRateBp).toBe(0);
    expect(invoice.taxTreatment).toBe("none");
    expect(invoice.quotedPaymentMethod).toBe("cash");
    // The existing exempt pair is what the PDF and summarizeTax already read,
    // so neither had to learn about tax treatments.
    expect(invoice.taxExempt).toBe(true);
    expect(invoice.taxExemptReason).toBe("Cash sale — no HST charged");
  });

  it("records an Interac e-transfer sale untaxed too", async () => {
    const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: "etransfer" });
    if (!created.ok) throw new Error("setup failed");
    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.totalCents).toBe(17500);
    expect(invoice.taxTreatment).toBe("none");
  });

  it("adds HST for credit and cheque — $175 becomes $197.75", async () => {
    for (const method of ["card_terminal", "stripe", "cheque"] as const) {
      const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: method });
      if (!created.ok) throw new Error("setup failed");
      const invoice = await loadInvoice(created.invoiceId);
      expect(invoice.taxCents).toBe(2275);
      expect(invoice.totalCents).toBe(19775);
      expect(invoice.taxTreatment).toBe("added");
      expect(invoice.quotedPaymentMethod).toBe(method);
    }
  });

  it("refuses an invoice with no payment method rather than guessing one", async () => {
    const result = await createManualInvoiceAction({ customerId, lines });
    expect(result.ok).toBe(false);
  });

  it("makes the restatement a query: none + a quoted method finds exactly the cash sales", async () => {
    await createManualInvoiceAction({ customerId, lines, paymentMethod: "cash" });
    await createManualInvoiceAction({ customerId, lines, paymentMethod: "card_terminal" });
    const exempted = await createManualInvoiceAction({
      customerId, lines, paymentMethod: "card_terminal",
      taxExempt: true, taxExemptReason: "Out-of-province customer",
    });
    if (!exempted.ok) throw new Error("setup failed");

    const all = await db().select().from(schema.invoices);
    const restatable = all.filter((i) => i.taxTreatment === "none" && i.quotedPaymentMethod !== null);
    expect(restatable).toHaveLength(1);
    expect(restatable[0]!.quotedPaymentMethod).toBe("cash");
    // The staff exemption is untaxed but must not be swept in with it.
    const staffExempt = all.find((i) => i.id === exempted.invoiceId)!;
    expect(staffExempt.taxTreatment).toBe("none");
    expect(staffExempt.quotedPaymentMethod).toBeNull();
  });

  it("separates cash from e-transfer on the tax report's exempt-reason table", async () => {
    for (const method of ["cash", "cash", "etransfer"] as const) {
      const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: method });
      if (!created.ok) throw new Error("setup failed");
      await db().update(schema.invoices).set({ status: "sent" })
        .where(eq(schema.invoices.id, created.invoiceId));
    }
    const summary = summarizeTax(await db().select().from(schema.invoices));
    expect(summary.taxCollectedCents).toBe(0);
    expect(summary.exemptInvoiceCount).toBe(3);
    expect(summary.exemptReasons.map((r) => [r.reason, r.count])).toEqual([
      ["Cash sale — no HST charged", 2],
      ["Interac e-transfer sale — no HST charged", 1],
    ]);
  });
});

describe("a payment that contradicts the invoice is refused, not absorbed", () => {
  async function issued(method: "cash" | "card_terminal") {
    const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: method });
    if (!created.ok) throw new Error("setup failed");
    await db().update(schema.invoices).set({ status: "sent" }).where(eq(schema.invoices.id, created.invoiceId));
    return created.invoiceId;
  }

  it("blocks a card payment against a cash invoice", async () => {
    const invoiceId = await issued("cash");
    const result = await recordPaymentAction({
      invoiceId, method: "card_terminal", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cancel this invoice and re-issue");
    expect(await db().select().from(schema.payments)).toHaveLength(0);
  });

  it("blocks a cash payment against a card invoice", async () => {
    const invoiceId = await issued("card_terminal");
    const result = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 19775, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts the method the invoice was issued for", async () => {
    const invoiceId = await issued("cash");
    const result = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(true);
    expect((await loadInvoice(invoiceId)).status).toBe("paid");
  });

  it("treats e-transfer as equivalent to cash, since neither is taxed", async () => {
    const invoiceId = await issued("cash");
    const result = await recordPaymentAction({
      invoiceId, method: "etransfer", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(true);
  });

  it("leaves pre-Release-3 invoices payable by any method across the swap", async () => {
    const invoiceId = await issued("card_terminal");
    // Exactly the shape of a row migrated by 0008: defaulted treatment, no
    // quoted method, taxed under the old always-add rule.
    await db().update(schema.invoices).set({ quotedPaymentMethod: null })
      .where(eq(schema.invoices.id, invoiceId));
    const result = await recordPaymentAction({
      invoiceId, method: "cash", amountCents: 19775, idempotencyKey: newId("pay"),
    });
    expect(result.ok).toBe(true);
  });

  it("supports the owner's cancel-and-re-issue path end to end", async () => {
    const invoiceId = await issued("cash");
    const blocked = await recordPaymentAction({
      invoiceId, method: "card_terminal", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(blocked.ok).toBe(false);

    const cancelled = await cancelInvoiceAction({ invoiceId, reason: "Customer paying by card instead" });
    expect(cancelled.ok).toBe(true);

    const reissued = await createManualInvoiceAction({ customerId, lines, paymentMethod: "card_terminal" });
    if (!reissued.ok) throw new Error("re-issue failed");
    await db().update(schema.invoices).set({ status: "sent" })
      .where(eq(schema.invoices.id, reissued.invoiceId));
    const paid = await recordPaymentAction({
      invoiceId: reissued.invoiceId, method: "card_terminal", amountCents: 19775, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);
    // The customer pays the card price, not the cash one.
    expect((await loadInvoice(reissued.invoiceId)).totalCents).toBe(19775);
  });

  it("stops blocking once a staff exemption replaces the payment-method reason", async () => {
    const created = await createManualInvoiceAction({ customerId, lines, paymentMethod: "card_terminal" });
    if (!created.ok) throw new Error("setup failed");
    const exempted = await setInvoiceTaxExemptAction({
      invoiceId: created.invoiceId, taxExempt: true, reason: "Exempt organisation",
    });
    expect(exempted.ok).toBe(true);

    const invoice = await loadInvoice(created.invoiceId);
    expect(invoice.taxTreatment).toBe("none");
    expect(invoice.quotedPaymentMethod).toBeNull();
    const paid = await recordPaymentAction({
      invoiceId: created.invoiceId, method: "cash", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(paid.ok).toBe(true);
  });
});

describe("discount reason", () => {
  it("takes a discount with no explanation at all — the owner does not record one", async () => {
    const result = await createManualInvoiceAction({
      customerId, lines, paymentMethod: "cash", discountCents: 2500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invoice = await loadInvoice(result.invoiceId);
    expect(invoice.discountCents).toBe(2500);
    expect(invoice.discountReason).toBeNull();
    expect(invoice.totalCents).toBe(15000);
  });

  it("still stores the reason when one is given", async () => {
    const result = await createManualInvoiceAction({
      customerId, lines, paymentMethod: "cash", discountCents: 2500, discountReason: "Service recovery",
    });
    if (!result.ok) throw new Error("setup failed");
    const invoice = await loadInvoice(result.invoiceId);
    expect(invoice.discountCents).toBe(2500);
    expect(invoice.discountReason).toBe("Service recovery");
  });

  it("accepts a zero discount unchanged", async () => {
    const result = await createManualInvoiceAction({
      customerId, lines, paymentMethod: "cash", discountPercentBp: 0,
    });
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
