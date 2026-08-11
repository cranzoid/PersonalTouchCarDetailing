import { describe, expect, it } from "vitest";
import {
  extractTemplateVariables,
  messageTemplateUpdateSchema,
  validateTemplateContent,
} from "../src/app/admin/(app)/communications/template-contracts";

describe("message template validation", () => {
  it("accepts valid template edits and bounds the body", () => {
    expect(
      messageTemplateUpdateSchema.safeParse({
        templateId: "tpl_1",
        channel: "email",
        subject: "Hello {{firstName}}",
        body: "Thanks for choosing {{businessName}}.",
        active: true,
      }).success,
    ).toBe(true);
    expect(
      messageTemplateUpdateSchema.safeParse({
        templateId: "tpl_1",
        channel: "email",
        subject: "Hello",
        body: "",
        active: true,
      }).success,
    ).toBe(false);
  });

  it("extracts unique renderer-compatible variables", () => {
    expect(
      extractTemplateVariables(
        "Hello {{firstName}} from {{businessName}}",
        "See you, {{firstName}}. {{not-valid}}",
      ),
    ).toEqual(["businessName", "firstName"]);
  });

  it("requires subjects for email and rejects unsupported known variables", () => {
    expect(
      validateTemplateContent("lead_ack", {
        channel: "email",
        subject: "",
        body: "Hi {{firstName}}",
      }),
    ).toBe("Email templates need a subject.");
    expect(
      validateTemplateContent("lead_ack", {
        channel: "email",
        subject: "Hello {{firstName}}",
        body: "Your appointment is {{date}}.",
      }),
    ).toBe("Unsupported variable for lead_ack: {{date}}.");
  });

  it("permits exactly the variables supplied by a known workflow", () => {
    expect(
      validateTemplateContent("invoice_sent", {
        channel: "email",
        subject: "Invoice {{invoiceNumber}} from {{businessName}}",
        body: "Hi {{firstName}}, pay {{total}} here: {{link}}",
      }),
    ).toBeNull();
  });

  it("accepts the promotional discount line on booking confirmations", () => {
    // The contract map gates staff edits, so a variable the booking action
    // supplies but the map omits would be rejected in the admin UI.
    expect(
      validateTemplateContent("booking_confirmation", {
        channel: "email",
        subject: "Booking confirmed — {{businessName}}",
        body: "Hi {{firstName}}, you're booked for {{services}}.\n{{discountLine}}Estimated total: {{total}}",
      }),
    ).toBeNull();
  });

  it("does not invent a contract for an unknown existing key", () => {
    expect(
      validateTemplateContent("existing_custom_key", {
        channel: "sms",
        subject: "",
        body: "Hello {{customValue}}",
      }),
    ).toBeNull();
  });
});
