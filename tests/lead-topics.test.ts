import { describe, expect, it } from "vitest";
import {
  callStatusLabel,
  isFollowUpDueFor,
  leadTopic,
  matchesLeadFilter,
  quoteStatusForLead,
  telHref,
  topicServicesLabel,
} from "../src/lib/lead-topics";
import { followUpValuesFor } from "../src/lib/quote-follow-ups";

const now = new Date("2026-11-10T15:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function lead(status: string, nextFollowUpAt: Date | null = null) {
  return { status, nextFollowUpAt };
}

describe("leadTopic", () => {
  it("reads the topic from the enquiry type the form stamped, then from the lead's kind", () => {
    expect(leadTopic({ kind: "quote", attribution: { enquiryType: "ceramic_callback" } })).toBe("ceramic_callback");
    expect(leadTopic({ kind: "quote", attribution: { enquiryType: "dash_cam" } })).toBe("dash_cam");
    expect(leadTopic({ kind: "quote", attribution: { enquiryType: "festive_coating_qr" } })).toBe("festive_coating");
    expect(leadTopic({ kind: "offer", attribution: null })).toBe("first_wash");
    expect(leadTopic({ kind: "fleet", attribution: { source: "fleet" } })).toBe("fleet");
    expect(leadTopic({ kind: "quote", attribution: { source: "google_ads" } })).toBe("general_quote");
    expect(leadTopic({ kind: "contact", attribution: null })).toBe("contact");
    expect(leadTopic({ kind: "general", attribution: null })).toBe("contact");
  });
});

describe("one status for a lead and its requests", () => {
  it("mirrors the lead's status onto its requests", () => {
    expect(quoteStatusForLead("new", false)).toBe("new");
    expect(quoteStatusForLead("contacted", false)).toBe("reviewing");
    expect(quoteStatusForLead("qualified", true)).toBe("estimated");
    expect(quoteStatusForLead("converted", false)).toBe("reviewing");
    expect(quoteStatusForLead("completed", true)).toBe("closed");
    expect(quoteStatusForLead("lost", false)).toBe("closed");
  });

  it("counts a follow-up as due only on someone already contacted and not finished with", () => {
    expect(isFollowUpDueFor(lead("contacted", daysAgo(1)), now)).toBe(true);
    expect(isFollowUpDueFor(lead("contacted", daysAgo(-1)), now)).toBe(false);
    expect(isFollowUpDueFor(lead("contacted"), now)).toBe(false);
    // A new lead is waiting for its first call, which the New chip shows.
    expect(isFollowUpDueFor(lead("new", daysAgo(1)), now)).toBe(false);
    expect(isFollowUpDueFor(lead("lost", daysAgo(1)), now)).toBe(false);
    expect(isFollowUpDueFor(lead("completed", daysAgo(1)), now)).toBe(false);
  });

  it("filters the way the chips are labelled", () => {
    expect(matchesLeadFilter(lead("new"), "new", now)).toBe(true);
    expect(matchesLeadFilter(lead("contacted"), "new", now)).toBe(false);
    expect(matchesLeadFilter(lead("contacted", daysAgo(1)), "due", now)).toBe(true);
    expect(matchesLeadFilter(lead("lost"), "lost", now)).toBe(true);
    expect(matchesLeadFilter(lead("lost"), "all", now)).toBe(true);
  });
});

describe("labels", () => {
  it("says whether anyone has called", () => {
    const day = (d: Date) => (d.getTime() === daysAgo(7).getTime() ? "Nov 3" : "?");
    expect(callStatusLabel({ lastFollowedUpAt: null }, 0, day)).toBe("Not called yet");
    expect(callStatusLabel({ lastFollowedUpAt: daysAgo(7) }, 2, day)).toBe("Contacted Nov 3 · 2 follow-ups");
    expect(callStatusLabel({ lastFollowedUpAt: daysAgo(7) }, 1, day)).toBe("Contacted Nov 3 · 1 follow-up");
  });

  it("builds a dialable link, and none for a number too short to dial", () => {
    expect(telHref("(905) 555-0142")).toBe("tel:9055550142");
    expect(telHref("+1 905-555-0142")).toBe("tel:+19055550142");
    expect(telHref("123")).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});

describe("follow-up wording by topic", () => {
  const base = {
    leadName: "Sam Rivera",
    vehicleInfo: null,
    serviceNames: [],
    requestedAt: now,
    settings: { businessName: "Personal Touch", phone: "905-555-0100", timezone: "America/Toronto" },
    baseUrl: "https://example.com",
  };

  it("never calls a dash cam request ceramic protection", () => {
    expect(followUpValuesFor({ ...base, topic: "dash_cam" }).services).toBe("dash cam installation");
    expect(topicServicesLabel("dash_cam")).not.toMatch(/ceramic/);
  });

  it("keeps ceramic protection for ceramic callbacks and the old default otherwise", () => {
    expect(followUpValuesFor({ ...base, topic: "ceramic_callback" }).services).toBe("ceramic protection");
    expect(followUpValuesFor(base).services).toBe("detailing");
    expect(followUpValuesFor({ ...base, topic: "general_quote" }).services).toBe("detailing");
  });

  it("names the attached services when there are any", () => {
    expect(followUpValuesFor({ ...base, topic: "dash_cam", serviceNames: ["Interior Detail"] }).services).toBe("Interior Detail");
  });
});
