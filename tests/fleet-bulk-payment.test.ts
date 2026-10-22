import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_fleet_bulk_payment_test",
  name: "Test Owner",
  email: "fleet-bulk@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  createManualInvoiceAction,
  recordFleetPaymentAction,
  recordPaymentAction,
} from "../src/app/admin/(app)/invoices/actions";

let fleetId: string;

// $175.00 of work, issued with 13% HST: $197.75.
const lines = [{ kind: "custom" as const, description: "Fleet wash", quantity: 1, unitPriceCents: 17500 }];

async function issued(customerId = fleetId) {
  const created = await createManualInvoiceAction({ customerId, lines });
  if (!created.ok) throw new Error("setup failed");
  await db().update(schema.invoices).set({ status: "sent" }).where(eq(schema.invoices.id, created.invoiceId));
  return created.invoiceId;
}

const batchKey = () => `fleetpay_${crypto.randomUUID()}`;

async function loadInvoices(ids: string[]) {
  return db().select().from(schema.invoices).where(inArray(schema.invoices.id, ids));
}

async function paymentsFor(ids: string[]) {
  return db().select().from(schema.payments).where(inArray(schema.payments.invoiceId, ids));
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers, leads,
     audit_log, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 3000 });
  fleetId = newId("cus");
  await db().insert(schema.customers).values({
    id: fleetId, firstName: "Fran", lastName: "Fleet", phone: "(905) 555-0190", preferredContact: "phone",
    customerType: "business", companyName: "Acme Couriers",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("recordFleetPaymentAction — one cheque, several invoices", () => {
  it("pays every selected invoice in full by cheque, tax kept, cheque number on each payment", async () => {
    const ids = [await issued(), await issued(), await issued()];
    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: ids, method: "cheque", reference: "004512", idempotencyKey: batchKey(),
    });
    expect(res).toEqual({ ok: true, invoiceCount: 3, totalCents: 3 * 19775 });

    for (const invoice of await loadInvoices(ids)) {
      expect(invoice.status).toBe("paid");
      expect(invoice.paidAt).not.toBeNull();
      expect(invoice.totalCents).toBe(19775);
      expect(invoice.taxTreatment).toBe("added");
      expect(invoice.quotedPaymentMethod).toBe("cheque");
    }
    const payments = await paymentsFor(ids);
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.provider === "cheque" && p.providerRef === "004512" && p.amountCents === 19775)).toBe(true);

    const summary = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "customer.bulk_payment_recorded"));
    expect(summary).toHaveLength(1);
    expect(summary[0].entityId).toBe(fleetId);
  });

  it("strips HST from each invoice when the fleet pays cash, exactly as one at a time would", async () => {
    const ids = [await issued(), await issued()];
    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: ids, method: "cash", idempotencyKey: batchKey(),
    });
    expect(res).toEqual({ ok: true, invoiceCount: 2, totalCents: 2 * 17500 });
    for (const invoice of await loadInvoices(ids)) {
      expect(invoice.status).toBe("paid");
      expect(invoice.taxCents).toBe(0);
      expect(invoice.totalCents).toBe(17500);
      expect(invoice.taxTreatment).toBe("none");
      expect(invoice.quotedPaymentMethod).toBe("cash");
    }
  });

  it("pays only what is left on a part-paid invoice", async () => {
    const partial = await issued();
    const fresh = await issued();
    const first = await recordPaymentAction({
      invoiceId: partial, method: "cheque", amountCents: 5000, idempotencyKey: newId("pay"),
    });
    expect(first.ok).toBe(true);

    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: [partial, fresh], method: "cheque", idempotencyKey: batchKey(),
    });
    expect(res).toEqual({ ok: true, invoiceCount: 2, totalCents: 19775 - 5000 + 19775 });
    expect((await loadInvoices([partial, fresh])).every((invoice) => invoice.status === "paid")).toBe(true);
  });

  it("treats a retry of the same batch as a no-op instead of paying twice", async () => {
    const ids = [await issued(), await issued()];
    const batch = { customerId: fleetId, invoiceIds: ids, method: "etransfer" as const, idempotencyKey: batchKey() };
    expect((await recordFleetPaymentAction(batch)).ok).toBe(true);
    const again = await recordFleetPaymentAction(batch);
    expect(again).toEqual({ ok: true, invoiceCount: 2, totalCents: 2 * 17500 });
    expect(await paymentsFor(ids)).toHaveLength(2);
  });

  it("writes nothing when one invoice cannot take the method, and names that invoice", async () => {
    const cashPart = await issued();
    const other = await issued();
    // Part-paid in cash, so it carries no tax and cannot now take a cheque.
    await recordPaymentAction({ invoiceId: cashPart, method: "cash", amountCents: 5000, idempotencyKey: newId("pay") });
    const [{ number }] = await loadInvoices([cashPart]);

    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: [cashPart, other], method: "cheque", idempotencyKey: batchKey(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(`INV-${number}`);

    const [untouched] = await loadInvoices([other]);
    expect(untouched.status).toBe("sent");
    expect(untouched.quotedPaymentMethod).toBeNull();
    expect(await paymentsFor([other])).toHaveLength(0);
    expect(await paymentsFor([cashPart])).toHaveLength(1);
  });

  it("refuses an invoice that is already paid", async () => {
    const done = await issued();
    const open = await issued();
    await recordPaymentAction({ invoiceId: done, method: "cheque", amountCents: 19775, idempotencyKey: newId("pay") });
    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: [done, open], method: "cheque", idempotencyKey: batchKey(),
    });
    expect(res.ok).toBe(false);
    expect(await paymentsFor([open])).toHaveLength(0);
  });

  it("refuses an invoice that belongs to a different customer", async () => {
    const otherCustomer = newId("cus");
    await db().insert(schema.customers).values({
      id: otherCustomer, firstName: "Other", lastName: "Person", phone: "(905) 555-0191", preferredContact: "phone",
    });
    const mine = await issued();
    const theirs = await issued(otherCustomer);
    const res = await recordFleetPaymentAction({
      customerId: fleetId, invoiceIds: [mine, theirs], method: "cheque", idempotencyKey: batchKey(),
    });
    expect(res.ok).toBe(false);
    expect(await paymentsFor([mine, theirs])).toHaveLength(0);
  });
});
