import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  classifyInboundKeyword,
  looksLikeOptOutRequest,
  recordInboundSms,
  verifyTwilioSignature,
} from "../src/lib/marketing/inbound";
import { isSuppressed } from "../src/lib/marketing/suppressions";
import { unsubscribeToken, verifyUnsubscribeToken } from "../src/lib/marketing/unsubscribe";

const AUTH_TOKEN = "test-auth-token-not-a-real-secret";

async function resetDb() {
  await db().execute(
    sql`TRUNCATE outreach_recipients, outreach_campaigns, marketing_suppressions, communications, webhook_events, leads, customers CASCADE`,
  );
}

function twilioSignature(url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", AUTH_TOKEN).update(Buffer.from(payload, "utf8")).digest("base64");
}

afterAll(async () => {
  await getPool().end();
});

describe("verifyTwilioSignature", () => {
  const url = "https://example.ca/api/webhooks/twilio/sms";
  const params = { From: "+19055551234", To: "+19055559999", Body: "STOP", MessageSid: "SM1" };

  it("accepts a request Twilio actually signed", () => {
    expect(
      verifyTwilioSignature({ url, params, signature: twilioSignature(url, params), authToken: AUTH_TOKEN }),
    ).toBe(true);
  });

  it("rejects a forged body under a captured signature", () => {
    const signature = twilioSignature(url, params);
    expect(
      verifyTwilioSignature({
        url,
        params: { ...params, From: "+19055550000" },
        signature,
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("rejects a signature made for a different URL", () => {
    const signature = twilioSignature("https://evil.example/api/webhooks/twilio/sms", params);
    expect(verifyTwilioSignature({ url, params, signature, authToken: AUTH_TOKEN })).toBe(false);
  });

  it("rejects a signature made with the wrong token", () => {
    const signature = createHmac("sha1", "wrong-token").update("anything").digest("base64");
    expect(verifyTwilioSignature({ url, params, signature, authToken: AUTH_TOKEN })).toBe(false);
  });

  it("rejects a missing or malformed signature", () => {
    expect(verifyTwilioSignature({ url, params, signature: null, authToken: AUTH_TOKEN })).toBe(false);
    expect(verifyTwilioSignature({ url, params, signature: "!!!", authToken: AUTH_TOKEN })).toBe(false);
  });
});

describe("classifyInboundKeyword", () => {
  it("recognises the standard stop keywords in any case or punctuation", () => {
    for (const word of ["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "cancel", "QUIT", "end"]) {
      expect(classifyInboundKeyword(word)).toBe("stop");
    }
  });

  it("recognises the resume keywords", () => {
    expect(classifyInboundKeyword("START")).toBe("start");
    expect(classifyInboundKeyword("unstop")).toBe("start");
  });

  it("does not treat an ordinary sentence as a keyword", () => {
    expect(classifyInboundKeyword("Stop by the shop on Tuesday")).toBeNull();
    expect(classifyInboundKeyword("Yes please send a quote")).toBeNull();
  });

  it("flags a plain-language opt-out for a person to handle", () => {
    expect(looksLikeOptOutRequest("please take me off your list")).toBe(true);
    expect(looksLikeOptOutRequest("do not text me again")).toBe(true);
    expect(looksLikeOptOutRequest("sounds good, send a quote")).toBe(false);
  });
});

describe("recordInboundSms", () => {
  beforeEach(resetDb);

  async function addLead(consent = true) {
    const id = newId("lead");
    await db().insert(schema.leads).values({
      id,
      name: "Dave Mitchell",
      phone: "(905) 555-1234",
      phoneNormalized: "9055551234",
      kind: "fleet",
      marketingConsent: consent,
    });
    return id;
  }

  it("files a reply against the lead it came from", async () => {
    const leadId = await addLead();
    const outcome = await recordInboundSms({
      messageSid: "SM100",
      from: "+19055551234",
      to: "+19055559999",
      body: "Yes please, send a quote",
      payload: {},
    });

    expect(outcome).toMatchObject({ processed: true, action: "reply", matchedLeadId: leadId });
    const [row] = await db().select().from(schema.communications);
    expect(row).toMatchObject({ direction: "inbound", channel: "sms", kind: "reply", leadId });
    expect(await isSuppressed("sms", "9055551234")).toBe(false);
  });

  it("opts the number out and clears consent on a STOP", async () => {
    const leadId = await addLead();
    const outcome = await recordInboundSms({
      messageSid: "SM101",
      from: "+19055551234",
      to: "+19055559999",
      body: "STOP",
      payload: {},
    });

    expect(outcome.action).toBe("stop");
    expect(await isSuppressed("sms", "905-555-1234")).toBe(true);
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead.marketingConsent).toBe(false);
  });

  it("ignores a retried delivery of the same message", async () => {
    await addLead();
    const first = await recordInboundSms({
      messageSid: "SM102",
      from: "+19055551234",
      to: "+19055559999",
      body: "Interested",
      payload: {},
    });
    const retry = await recordInboundSms({
      messageSid: "SM102",
      from: "+19055551234",
      to: "+19055559999",
      body: "Interested",
      payload: {},
    });

    expect(first.processed).toBe(true);
    expect(retry.processed).toBe(false);
    expect(await db().select().from(schema.communications)).toHaveLength(1);
  });

  it("lifts the block on START without restoring consent by itself", async () => {
    const leadId = await addLead();
    await recordInboundSms({ messageSid: "SM103", from: "+19055551234", to: "+1", body: "STOP", payload: {} });
    await recordInboundSms({ messageSid: "SM104", from: "+19055551234", to: "+1", body: "START", payload: {} });

    expect(await isSuppressed("sms", "9055551234")).toBe(false);
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead.marketingConsent).toBe(false);
  });

  it("still records a STOP from a number we do not recognise", async () => {
    const outcome = await recordInboundSms({
      messageSid: "SM105",
      from: "+16135550000",
      to: "+19055559999",
      body: "STOP",
      payload: {},
    });

    expect(outcome).toMatchObject({ matchedLeadId: null, matchedCustomerId: null, action: "stop" });
    expect(await isSuppressed("sms", "6135550000")).toBe(true);
  });

  it("marks a plain-language opt-out as needing a person", async () => {
    await addLead();
    const outcome = await recordInboundSms({
      messageSid: "SM106",
      from: "+19055551234",
      to: "+19055559999",
      body: "please take me off your list",
      payload: {},
    });

    expect(outcome.action).toBe("reply");
    expect(outcome.needsAttention).toBe(true);
    // Deliberately NOT auto-suppressed: a human decides, so the reply cannot be
    // silently swallowed by a phrase match.
    expect(await isSuppressed("sms", "9055551234")).toBe(false);
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips the recipient it was issued for", () => {
    const token = unsubscribeToken("orc_abc123");
    expect(verifyUnsubscribeToken(token)).toBe("orc_abc123");
  });

  it("rejects a token pointed at somebody else", () => {
    const token = unsubscribeToken("orc_abc123");
    const tampered = token.replace("orc_abc123", "orc_victim99");
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a token with an altered signature", () => {
    const token = unsubscribeToken("orc_abc123");
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken("orc_abc123")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });
});
