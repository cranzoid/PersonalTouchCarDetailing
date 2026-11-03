import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_cash_keep_tax_test",
  name: "Test Owner",
  email: "cash-keep-tax@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { createManualInvoiceAction, recordPaymentAction } from "../src/app/admin/(app)/invoices/actions";

let customerId: string;

// $175.00 of work, issued with 13% HST: $197.75.
async function issued() {
  const created = await createManualInvoiceAction({
    customerId,
    lines: [{ kind: "custom" as const, description: "Package #2", quantity: 1, unitPriceCents: 17500 }],
  });
  if (!created.ok) throw new Error("setup failed");
  return created.invoiceId;
}

async function load(id: string) {
  return (await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers, leads,
     audit_log, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 4000 });
  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Casey", lastName: "Cash", phone: "(905) 555-0191", preferredContact: "phone",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("recording cash with the customer paying HST", () => {
  it("takes $197.75 in cash and leaves HST on the invoice, counted as collected", async () => {
    const id = await issued();
    const res = await recordPaymentAction({
      invoiceId: id, method: "cash", amountCents: 19775, idempotencyKey: newId("pay"), keepTax: true,
    });
    expect(res.ok).toBe(true);

    const invoice = await load(id);
    expect(invoice.status).toBe("paid");
    expect(invoice.taxCents).toBe(2275);
    expect(invoice.totalCents).toBe(19775);
    expect(invoice.taxTreatment).toBe("added");
    expect(invoice.quotedPaymentMethod).toBe("cash");
    // No "No HST charged" line: that line is driven by taxExempt.
    expect(invoice.taxExempt).toBe(false);
    expect(invoice.taxExemptReason).toBeNull();

    const kept = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "invoice.tax_kept_on_untaxed_method"));
    expect(kept).toHaveLength(1);
  });

  it("still strips HST from cash when the box is not ticked", async () => {
    const id = await issued();
    const refused = await recordPaymentAction({
      invoiceId: id, method: "cash", amountCents: 19775, idempotencyKey: newId("pay"),
    });
    expect(refused.ok).toBe(false);
    const res = await recordPaymentAction({
      invoiceId: id, method: "cash", amountCents: 17500, idempotencyKey: newId("pay"),
    });
    expect(res.ok).toBe(true);
    const invoice = await load(id);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.taxTreatment).toBe("none");
  });

  it("lets a part-paid kept-tax invoice be finished in cash or by card", async () => {
    const id = await issued();
    expect((await recordPaymentAction({
      invoiceId: id, method: "cash", amountCents: 10000, idempotencyKey: newId("pay"), keepTax: true,
    })).ok).toBe(true);
    // The second payment does not need the box: the treatment is settled.
    expect((await recordPaymentAction({
      invoiceId: id, method: "cash", amountCents: 5000, idempotencyKey: newId("pay"),
    })).ok).toBe(true);
    expect((await recordPaymentAction({
      invoiceId: id, method: "card_terminal", amountCents: 4775, idempotencyKey: newId("pay"),
    })).ok).toBe(true);
    const invoice = await load(id);
    expect(invoice.status).toBe("paid");
    expect(invoice.totalCents).toBe(19775);
  });
});
