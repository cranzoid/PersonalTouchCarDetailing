import { describe, expect, it } from "vitest";
import {
  callStatusLabel,
  leadTopic,
  matchesRequestFilter,
  needsCall,
  sortForCalling,
  telHref,
  topicServicesLabel,
  waitingLabel,
} from "../src/lib/lead-topics";
import { followUpValuesFor } from "../src/lib/quote-follow-ups";

const now = new Date("2026-11-10T15:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function request(
  id: string,
  over: Partial<{ status: string; createdAt: Date; lastFollowedUpAt: Date | null; nextFollowUpAt: Date | null }> = {},
) {
  return { id, status: "new", createdAt: daysAgo(1), lastFollowedUpAt: null, nextFollowUpAt: null, ...over };
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

describe("the call queue", () => {
  it("counts a request as needing a call until a follow-up is logged, and never once closed", () => {
    expect(needsCall(request("a"))).toBe(true);
    expect(needsCall(request("b", { lastFollowedUpAt: daysAgo(1) }))).toBe(false);
    expect(needsCall(request("c", { status: "closed" }))).toBe(false);
  });

  it("puts uncalled requests first, longest-waiting on top, then due follow-ups, then the rest, closed last", () => {
    const list = [
      request("closed", { status: "closed", createdAt: daysAgo(9) }),
      request("contacted-new", { createdAt: daysAgo(2), lastFollowedUpAt: daysAgo(1), nextFollowUpAt: daysAgo(-2) }),
      request("uncalled-newer", { createdAt: daysAgo(1) }),
      request("due", { createdAt: daysAgo(6), lastFollowedUpAt: daysAgo(3), nextFollowUpAt: daysAgo(0.5) }),
      request("uncalled-oldest", { createdAt: daysAgo(5) }),
    ];
    expect(sortForCalling(list, now).map((r) => r.id)).toEqual([
      "uncalled-oldest",
      "uncalled-newer",
      "due",
      "contacted-new",
      "closed",
    ]);
  });

  it("filters the way the chips are labelled", () => {
    const uncalled = request("u", { nextFollowUpAt: daysAgo(1) });
    const called = request("c", { lastFollowedUpAt: daysAgo(2), nextFollowUpAt: daysAgo(-1) });
    const closed = request("x", { status: "closed", lastFollowedUpAt: daysAgo(2) });
    expect(matchesRequestFilter(uncalled, "call", now)).toBe(true);
    expect(matchesRequestFilter(called, "call", now)).toBe(false);
    expect(matchesRequestFilter(uncalled, "due", now)).toBe(true);
    expect(matchesRequestFilter(called, "due", now)).toBe(false);
    expect(matchesRequestFilter(called, "contacted", now)).toBe(true);
    expect(matchesRequestFilter(closed, "contacted", now)).toBe(false);
    expect(matchesRequestFilter(closed, "closed", now)).toBe(true);
    expect(matchesRequestFilter(closed, "all", now)).toBe(true);
  });
});

describe("labels", () => {
  it("says how long a request has waited", () => {
    expect(waitingLabel(daysAgo(3), now)).toBe("Waiting 3 days");
    expect(waitingLabel(daysAgo(1), now)).toBe("Waiting 1 day");
    expect(waitingLabel(daysAgo(0.2), now)).toBe("Waiting since today");
  });

  it("says whether anyone has called", () => {
    const day = (d: Date) => (d.getTime() === daysAgo(7).getTime() ? "Nov 3" : "?");
    expect(callStatusLabel({ status: "new", lastFollowedUpAt: null }, 0, day)).toBe("Not called yet");
    expect(callStatusLabel({ status: "new", lastFollowedUpAt: daysAgo(7) }, 2, day)).toBe("Contacted Nov 3 · 2 follow-ups");
    expect(callStatusLabel({ status: "new", lastFollowedUpAt: daysAgo(7) }, 1, day)).toBe("Contacted Nov 3 · 1 follow-up");
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
