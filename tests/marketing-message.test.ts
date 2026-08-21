import { describe, expect, it } from "vitest";
import { checkCampaignCompliance, emailComplianceFooter } from "../src/lib/marketing/compliance";
import { parseContactPaste } from "../src/lib/marketing/import";
import {
  renderOutreachBody,
  smsSegments,
  unknownMergeFields,
  withinSendWindow,
} from "../src/lib/marketing/message";
import { normalizeDestination } from "../src/lib/marketing/suppressions";

describe("renderOutreachBody", () => {
  it("fills the merge fields", () => {
    expect(renderOutreachBody("Hi {{FirstName}} at {{Company}}", { firstName: "Dave", companyName: "Acme" })).toBe(
      "Hi Dave at Acme",
    );
  });

  it("leaves nothing behind when a value is empty", () => {
    expect(renderOutreachBody("Hi {{FirstName}}!", { firstName: "", companyName: "" })).toBe("Hi !");
  });
});

describe("unknownMergeFields", () => {
  it("accepts the supported fields", () => {
    expect(unknownMergeFields("{{FirstName}} {{Company}}")).toEqual([]);
  });

  it("catches a typo before it is sent to anyone", () => {
    expect(unknownMergeFields("Hi {{Frist_name}} at {{Company}}")).toEqual(["Frist_name"]);
  });

  it("reports each unknown field once", () => {
    expect(unknownMergeFields("{{Owner}} {{Owner}}")).toEqual(["Owner"]);
  });
});

describe("smsSegments", () => {
  it("counts a short plain message as one GSM-7 segment", () => {
    const result = smsSegments("Hi Dave, quick question about your fleet.");
    expect(result.encoding).toBe("GSM-7");
    expect(result.segments).toBe(1);
  });

  it("splits at 160 characters, then at 153", () => {
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("a".repeat(306)).segments).toBe(2);
    expect(smsSegments("a".repeat(307)).segments).toBe(3);
  });

  it("charges two septets for GSM-7 extended characters", () => {
    // 80 euro signs are 160 septets — still one segment, but only just.
    expect(smsSegments("€".repeat(80)).segments).toBe(1);
    expect(smsSegments("€".repeat(81)).segments).toBe(2);
  });

  it("drops to UCS-2 and 70 characters when a curly quote sneaks in", () => {
    const result = smsSegments(`We${"’"}re under new ownership`);
    expect(result.encoding).toBe("UCS-2");
    expect(result.nonGsmCharacters).toContain("’");
    expect(smsSegments("a".repeat(70) + "’").segments).toBe(2);
  });

  it("reports an empty message as zero segments", () => {
    expect(smsSegments("").segments).toBe(0);
  });
});

describe("withinSendWindow", () => {
  const tz = "America/Toronto";

  it("allows a weekday afternoon", () => {
    // 2026-08-21T18:00Z is 14:00 in Toronto (EDT).
    expect(withinSendWindow(new Date("2026-08-21T18:00:00Z"), tz)).toEqual({ allowed: true, localHour: 14 });
  });

  it("blocks the early morning", () => {
    // 10:00Z is 06:00 local.
    expect(withinSendWindow(new Date("2026-08-21T10:00:00Z"), tz).allowed).toBe(false);
  });

  it("blocks late evening", () => {
    // 01:00Z is 21:00 local the previous day.
    expect(withinSendWindow(new Date("2026-08-22T01:00:00Z"), tz).allowed).toBe(false);
  });
});

describe("normalizeDestination", () => {
  it("reduces every spelling of a number to the same key", () => {
    const forms = ["(905) 555-1234", "905.555.1234", "+1 905 555 1234", "19055551234"];
    const keys = new Set(forms.map((form) => normalizeDestination("sms", form)));
    expect(keys).toEqual(new Set(["9055551234"]));
  });

  it("lowercases and trims email", () => {
    expect(normalizeDestination("email", "  Dave@Example.COM ")).toBe("dave@example.com");
  });

  it("rejects something that is not an address", () => {
    expect(normalizeDestination("email", "dave at example")).toBeNull();
    expect(normalizeDestination("sms", "no digits here")).toBeNull();
  });
});

describe("checkCampaignCompliance", () => {
  const businessName = "Personal Touch Car Detailing";

  it("blocks an SMS with no opt-out instruction", () => {
    const issues = checkCampaignCompliance({
      channel: "sms",
      subject: null,
      body: "Hi {{FirstName}}, Personal Touch here. Want a fleet quote?",
      businessName,
    });
    expect(issues.some((i) => i.level === "error" && i.message.includes("opt out"))).toBe(true);
  });

  it("accepts an SMS that names the sender and says STOP", () => {
    const issues = checkCampaignCompliance({
      channel: "sms",
      subject: null,
      body: "Hi {{FirstName}}, Dave from Personal Touch Car Detailing. Fleet quote? Reply STOP to opt out.",
      businessName,
    });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.filter((i) => i.level === "warning")).toEqual([]);
  });

  it("warns when the sender is not named", () => {
    const issues = checkCampaignCompliance({
      channel: "sms",
      subject: null,
      body: "Hi {{FirstName}}, want a fleet quote? Reply STOP to opt out.",
      businessName,
    });
    expect(issues.some((i) => i.level === "warning" && i.message.includes("identified"))).toBe(true);
  });

  it("requires a subject line on email", () => {
    const issues = checkCampaignCompliance({ channel: "email", subject: "", body: "Hello", businessName });
    expect(issues.some((i) => i.level === "error" && i.message.includes("subject"))).toBe(true);
  });

  it("rejects an empty body", () => {
    const issues = checkCampaignCompliance({ channel: "sms", subject: null, body: "   ", businessName });
    expect(issues).toEqual([{ level: "error", message: "The message body is empty." }]);
  });
});

describe("emailComplianceFooter", () => {
  it("carries the sender identity and a working unsubscribe link", () => {
    const footer = emailComplianceFooter(
      {
        businessName: "Personal Touch Car Detailing",
        addressLine1: "2481 Upper James St",
        city: "Hamilton",
        province: "ON",
        postalCode: "L0R 1W0",
        phone: "905-679-0143",
        email: "info@example.ca",
      },
      "https://example.ca/unsubscribe/abc",
    );
    expect(footer).toContain("Personal Touch Car Detailing");
    expect(footer).toContain("2481 Upper James St, Hamilton, ON, L0R 1W0");
    expect(footer).toContain("905-679-0143");
    expect(footer).toContain("https://example.ca/unsubscribe/abc");
  });
});

describe("parseContactPaste", () => {
  it("reads the documented column order", () => {
    const { contacts, errors } = parseContactPaste(
      "Dave, Hamilton Plumbing, 905 555 1234, dave@hamiltonplumbing.ca",
    );
    expect(errors).toEqual([]);
    expect(contacts[0]).toMatchObject({
      firstName: "Dave",
      companyName: "Hamilton Plumbing",
      phone: "905 555 1234",
      email: "dave@hamiltonplumbing.ca",
    });
  });

  it("maps columns from a header row in any order", () => {
    const { contacts } = parseContactPaste(
      ["Email\tPhone\tCompany\tFirst name", "sarah@couriers.ca\t2895558877\tAncaster Couriers\tSarah"].join("\n"),
    );
    expect(contacts[0]).toMatchObject({
      firstName: "Sarah",
      companyName: "Ancaster Couriers",
      phone: "2895558877",
      email: "sarah@couriers.ca",
    });
  });

  it("keeps a comma inside a tab-separated company name", () => {
    const { contacts } = parseContactPaste("Dave\tSmith, Sons & Co\t9055551234");
    expect(contacts[0].companyName).toBe("Smith, Sons & Co");
  });

  it("splits a single full-name cell so the greeting uses the first name", () => {
    const { contacts } = parseContactPaste("Dave Mitchell, Hamilton Plumbing, 9055551234");
    expect(contacts[0].firstName).toBe("Dave");
    expect(contacts[0].lastName).toBe("Mitchell");
  });

  it("rescues an email and phone that appear in unexpected columns", () => {
    const { contacts } = parseContactPaste("Dave, dave@example.ca, Hamilton Plumbing, 9055551234");
    expect(contacts[0].email).toBe("dave@example.ca");
    expect(contacts[0].phone).toBe("9055551234");
  });

  it("rejects a row with no way to reach anyone", () => {
    const { contacts, errors } = parseContactPaste("Dave, Hamilton Plumbing");
    expect(contacts).toEqual([]);
    expect(errors[0].problem).toBe("No usable phone number or email address");
  });

  it("rejects a row with a destination but nobody attached to it", () => {
    const { contacts, errors } = parseContactPaste(",,9055551234,");
    expect(contacts).toEqual([]);
    expect(errors[0].problem).toBe("No name or company");
  });

  it("ignores blank lines", () => {
    const { contacts } = parseContactPaste("Dave, Acme, 9055551234\n\n\nSarah, Couriers, 2895558877\n");
    expect(contacts).toHaveLength(2);
  });
});
