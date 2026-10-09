/**
 * The wording side of quote follow-ups — the texts and emails staff send from a
 * quote (or callback) request to chase it.
 *
 * Client-safe and pure, like wash-offer-nudge-message.ts, so the composer
 * previews with the SAME function the server sends with. Placeholders are the
 * camelCase ones the other templates use, so they read the same in
 * Admin → Communications.
 */
import { checkCampaignCompliance } from "./marketing/compliance";

export type FollowUpChannel = "sms" | "email";

export const FOLLOW_UP_TEMPLATE_KEYS: Record<FollowUpChannel, string> = {
  sms: "quote_follow_up_sms",
  email: "quote_follow_up_email",
};

export const FOLLOW_UP_PLACEHOLDERS = [
  { key: "firstName", hint: "Their first name" },
  { key: "vehicle", hint: "Their vehicle, or “vehicle”" },
  { key: "services", hint: "What they asked about" },
  { key: "requestedOn", hint: "The day they asked, e.g. Oct 8" },
  { key: "bookingLink", hint: "Link to book online" },
  { key: "phone", hint: "The shop's phone number" },
  { key: "businessName", hint: "The shop's name" },
] as const;

export type FollowUpPlaceholder = (typeof FOLLOW_UP_PLACEHOLDERS)[number]["key"];
export type FollowUpValues = Record<FollowUpPlaceholder, string>;

/**
 * The starting wording. Also what the seed writes into message_templates, so
 * there is one source for it.
 *
 * The SMS keeps to plain characters (no em dashes or curly quotes) so it stays
 * one GSM-7 segment per 160 characters, names the sender, and carries the STOP
 * line CASL wants in every commercial text — the send is refused without it.
 */
export const DEFAULT_FOLLOW_UP_SMS =
  "{{businessName}}: Hi {{firstName}}, following up on your request about your {{vehicle}}. Any questions, or want to pick a time? Call or text {{phone}}, or book at {{bookingLink}} Reply STOP to opt out.";

export const DEFAULT_FOLLOW_UP_EMAIL_SUBJECT = "Following up on your request — {{businessName}}";

export const DEFAULT_FOLLOW_UP_EMAIL_BODY = [
  "Hi {{firstName}},",
  "",
  "Thanks again for getting in touch about {{services}} for your {{vehicle}}. I wanted to follow up and see whether you had any questions, or would like to go ahead and book a time.",
  "",
  "You can reply to this email, call or text us on {{phone}}, or pick a time online:",
  "{{bookingLink}}",
  "",
  "Thanks,",
  "{{businessName}}",
].join("\n");

/** Hard ceilings on what one follow-up may be. */
export const FOLLOW_UP_LIMITS = {
  smsBody: 640,
  emailSubject: 200,
  emailBody: 10_000,
  note: 4_000,
} as const;

/** Ways a follow-up can happen. The first two are sent from the CRM. */
export const FOLLOW_UP_METHODS = {
  sms: "Text sent",
  email: "Email sent",
  call: "Phone call",
  voicemail: "Left a voicemail",
  in_person: "Spoke in person",
  other: "Other",
} as const;

export type FollowUpMethod = keyof typeof FOLLOW_UP_METHODS;

/** The methods staff log by hand, after the fact. */
export const LOGGED_FOLLOW_UP_METHODS = ["call", "voicemail", "in_person", "other"] as const;

/** Days ahead the "next follow-up" field starts at after a follow-up. */
export const DEFAULT_FOLLOW_UP_GAP_DAYS = 3;

export function renderFollowUp(text: string, values: FollowUpValues): string {
  const vars = values as Record<string, string>;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/** Placeholders we cannot fill — caught in the composer, and refused by the send. */
export function unknownFollowUpPlaceholders(...parts: (string | null | undefined)[]): string[] {
  const known = new Set<string>(FOLLOW_UP_PLACEHOLDERS.map((p) => p.key));
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!known.has(match[1])) found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * The first thing wrong with a follow-up's wording, or null.
 *
 * Judged on the RENDERED text, as the customer would read it: "{{businessName}}"
 * does not contain the shop's name, the text it becomes does. Shared by the
 * composer and the server so the button and the send never disagree.
 */
export function followUpWordingProblem(input: {
  channel: FollowUpChannel;
  subject: string;
  body: string;
  values: FollowUpValues;
  businessName: string;
}): string | null {
  if (input.channel === "sms" && input.body.length > FOLLOW_UP_LIMITS.smsBody) {
    return `A text can be at most ${FOLLOW_UP_LIMITS.smsBody} characters.`;
  }
  if (input.channel === "email" && input.subject.length > FOLLOW_UP_LIMITS.emailSubject) {
    return `A subject can be at most ${FOLLOW_UP_LIMITS.emailSubject} characters.`;
  }
  const unknown = unknownFollowUpPlaceholders(input.subject, input.body);
  if (unknown.length > 0) {
    return `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}.`;
  }
  const blocking = checkCampaignCompliance({
    channel: input.channel,
    subject: input.channel === "email" ? renderFollowUp(input.subject, input.values) : null,
    body: renderFollowUp(input.body, input.values),
    businessName: input.businessName,
  }).filter((issue) => issue.level === "error");
  return blocking[0]?.message ?? null;
}
