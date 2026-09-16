/**
 * The wording side of first-wash nudges — the texts and emails staff send by
 * hand to people who claimed a wash code and have not booked it.
 *
 * Pure, like marketing/message.ts, so the admin composer renders the preview
 * with the SAME function the server sends with. A preview computed by
 * different code from the one that sends is a preview that will eventually lie.
 *
 * Placeholders are the camelCase ones the other offer-claim templates already
 * use (seed-runner.ts), so the two families read the same in
 * Admin → Communications.
 */

export type NudgeChannel = "sms" | "email";

export const NUDGE_TEMPLATE_KEYS: Record<NudgeChannel, string> = {
  sms: "offer_claim_nudge_sms",
  email: "offer_claim_nudge_email",
};

export const NUDGE_PLACEHOLDERS = [
  { key: "firstName", hint: "Their first name" },
  { key: "code", hint: "Their code, e.g. PTW-7QK2MB" },
  { key: "price", hint: "The offer price, e.g. $15.99" },
  { key: "expires", hint: "The day the code runs out" },
  { key: "daysLeft", hint: "“5 days”, “1 day” or “today”" },
  { key: "link", hint: "Short link straight into booking" },
  { key: "phone", hint: "The shop's phone number" },
  { key: "businessName", hint: "The shop's name" },
] as const;

export type NudgePlaceholder = (typeof NUDGE_PLACEHOLDERS)[number]["key"];
export type NudgeValues = Record<NudgePlaceholder, string>;

/**
 * The starting wording. Also what the seed writes into message_templates, so
 * there is one source for it.
 *
 * The SMS avoids em dashes and curly quotes on purpose: one of either drops a
 * text to UCS-2 and 70 characters a segment, which doubles what each nudge
 * costs. It names the sender and carries the STOP line because CASL wants both
 * in every commercial text, and the send is refused without the latter.
 */
export const DEFAULT_NUDGE_SMS =
  "{{businessName}}: Hi {{firstName}}, your {{price}} first wash is still waiting. Code {{code}} is good until {{expires}}. Book: {{link}} Reply STOP to opt out.";

export const DEFAULT_NUDGE_EMAIL_SUBJECT = "{{firstName}}, your {{price}} first wash is still waiting";

export const DEFAULT_NUDGE_EMAIL_BODY = [
  "Hi {{firstName}},",
  "",
  "Just a friendly reminder that your {{price}} first hand wash hasn't been used yet.",
  "",
  "Your code: {{code}}",
  "Valid until: {{expires}} ({{daysLeft}} left)",
  "",
  "Pick a time that suits you here:",
  "{{link}}",
  "",
  "Or call us on {{phone}} and we'll book it for you.",
  "",
  "See you soon,",
  "{{businessName}}",
].join("\n");

/** Hard ceilings on what one nudge may be. */
export const NUDGE_LIMITS = { smsBody: 640, emailSubject: 200, emailBody: 10_000 } as const;

/** One press of "send" reaches at most this many people. Matches campaigns. */
export const MAX_NUDGE_BATCH = 25;

/**
 * The same person is not nudged twice on the same channel inside this window.
 * Twenty hours rather than twenty-four, so "once a day" still works for a shop
 * that sends at slightly different times each morning.
 */
export const NUDGE_COOLDOWN_MS = 20 * 60 * 60 * 1000;

export function renderNudge(text: string, values: NudgeValues): string {
  const vars = values as Record<string, string>;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/** Placeholders we cannot fill — caught in the composer, and refused by the send. */
export function unknownNudgePlaceholders(...parts: (string | null | undefined)[]): string[] {
  const known = new Set<string>(NUDGE_PLACEHOLDERS.map((p) => p.key));
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!known.has(match[1])) found.add(match[1]);
    }
  }
  return [...found];
}

/** "5 days", "1 day", "today" — counted in whole days, rounding up. */
export function daysLeftLabel(expiresAt: Date, nowMs: number = Date.now()): string {
  const days = Math.ceil((expiresAt.getTime() - nowMs) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}
