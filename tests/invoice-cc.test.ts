import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { MAX_CC_RECIPIENTS, parseCcList, splitCcInput } from "../src/lib/email";
import { sendMessageTemplate } from "../src/lib/messaging";
import { sendInvoiceReceipt } from "../src/lib/invoices";

describe("parseCcList", () => {
  it("normalizes, de-duplicates and drops the primary recipient", () => {
    const result = parseCcList(
      ["  Accounts@Company.com ", "accounts@company.com", "owner@company.com", ""],
      "OWNER@company.com",
    );
    expect(result).toEqual({ ok: true, cc: ["accounts@company.com"] });
  });

  it("rejects a malformed address by name rather than dropping it", () => {
    const result = parseCcList(["accounts@company.com", "not-an-email"], null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not-an-email");
  });

  it("enforces the recipient cap", () => {
    const many = Array.from({ length: MAX_CC_RECIPIENTS + 1 }, (_, i) => `p${i}@company.com`);
    expect(parseCcList(many, null).ok).toBe(false);
    expect(parseCcList(many.slice(0, MAX_CC_RECIPIENTS), null).ok).toBe(true);
  });

  it("accepts an empty list", () => {
    expect(parseCcList([], "owner@company.com")).toEqual({ ok: true, cc: [] });
  });
});

describe("splitCcInput", () => {
  it("splits on commas, semicolons and newlines", () => {
    expect(splitCcInput("a@x.com, b@x.com; c@x.com\nd@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("yields nothing for whitespace", () => {
    expect(splitCcInput("   ")).toEqual([]);
  });
});

async function resetDb() {
  await db().execute(
    sql`TRUNCATE communications, message_templates, invoices, customers, invoice_counters CASCADE`,
  );
}

describe("cc delivery", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(resetDb);

  async function addTemplate(key: string, channel: string) {
    await db().insert(schema.messageTemplates).values({
      id: newId("tpl"),
      key,
      channel,
      subject: "Hello {{firstName}}",
      body: "Hi {{firstName}}",
      active: true,
    });
  }

  async function addCustomer(marketingConsent = true) {
    const id = newId("cus");
    await db().insert(schema.customers).values({
      id,
      firstName: "Ari",
      lastName: "Customer",
      email: "customer@example.com",
      phone: "+15551234567",
      marketingConsent,
    });
    return id;
  }

  it("records the cc list on the communications row", async () => {
    await addTemplate("invoice_sent", "email");
    const customerId = await addCustomer();
    const result = await sendMessageTemplate({
      templateKey: "invoice_sent",
      recipient: { email: "customer@example.com" },
      customerId,
      kind: "invoice",
      cc: ["accounts@company.com"],
      variables: { firstName: "Ari" },
    });

    expect(result.sent).toBe(true);
    const [message] = await db().select().from(schema.communications);
    expect(message.cc).toEqual(["accounts@company.com"]);
  });

  it("drops the cc on an sms template rather than texting a second party", async () => {
    await addTemplate("invoice_sent", "sms");
    const customerId = await addCustomer();
    await sendMessageTemplate({
      templateKey: "invoice_sent",
      recipient: { email: "customer@example.com", phone: "+15551234567" },
      customerId,
      kind: "invoice",
      cc: ["accounts@company.com"],
      variables: { firstName: "Ari" },
    });

    const [message] = await db().select().from(schema.communications);
    expect(message.channel).toBe("sms");
    expect(message.cc).toEqual([]);
  });

  it("never lets a cc carry marketing mail past the consent gate", async () => {
    await addTemplate("review_request", "email");
    // Consent granted, so the message itself goes out — what must not happen is
    // the courtesy copy riding along to a party who never consented.
    const customerId = await addCustomer(true);
    await sendMessageTemplate({
      templateKey: "review_request",
      recipient: { email: "customer@example.com" },
      customerId,
      kind: "review_request",
      cc: ["accounts@company.com"],
      variables: { firstName: "Ari" },
    });

    const [message] = await db().select().from(schema.communications);
    expect(message.status).toBe("logged");
    expect(message.cc).toEqual([]);
  });

  it("copies the invoice cc list on the payment receipt", async () => {
    await addTemplate("receipt", "email");
    const customerId = await addCustomer();
    const invoiceId = newId("inv");
    await db().insert(schema.invoices).values({
      id: invoiceId,
      number: 9001,
      customerId,
      status: "paid",
      taxRateBp: 1300,
      totalCents: 10000,
      ccEmails: ["accounts@company.com", "customer@example.com"],
    });

    await sendInvoiceReceipt(invoiceId, 10000);

    const [message] = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.kind, "receipt"));
    // The customer's own address is stripped: they are already the primary
    // recipient, and a duplicate would show them their own name in the CC.
    expect(message.cc).toEqual(["accounts@company.com"]);
  });
});
