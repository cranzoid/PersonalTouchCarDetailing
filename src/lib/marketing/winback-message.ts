/**
 * The wording side of win-back outreach — the texts and emails staff send by
 * hand to people whose booking was cancelled or who never turned up.
 *
 * Pure, like ./message.ts, so the composer in the browser renders its preview
 * with the SAME functions the server sends with. The merge fields themselves
 * are the campaign ones ({{FirstName}}, {{Company}}, {{LastVisit}}) because a
 * win-back send IS a campaign underneath — see ./winback.ts for why that
 * matters more than it looks.
 */

import { OUTREACH_MERGE_FIELDS } from "./message";

export const WINBACK_TEMPLATE_KEYS = {
  sms: "winback_sms",
  email: "winback_email",
} as const;

/** Hard ceilings on what one win-back message may be. Matches the nudges. */
export const WINBACK_LIMITS = { smsBody: 640, emailSubject: 200, emailBody: 10_000 } as const;

/** One press of "send" reaches at most this many people. Matches campaigns. */
export const MAX_WINBACK_BATCH = 25;

export const WINBACK_PLACEHOLDERS: { key: (typeof OUTREACH_MERGE_FIELDS)[number]; hint: string }[] = [
  { key: "FirstName", hint: "Their first name" },
  { key: "Company", hint: "Their company — blank for a private customer" },
  { key: "LastVisit", hint: "The date of the booking they missed" },
];

/**
 * Starting wording, not finished copy — the owner edits it and saves their own.
 *
 * The shop's name is baked in from settings rather than left as a placeholder:
 * CASL wants the sender identified in every commercial message, and a send is
 * warned about without it. The text avoids em dashes and curly quotes on
 * purpose — one of either drops a text to UCS-2 and 70 characters a segment,
 * which doubles what each message costs.
 */
export function defaultWinbackSms(businessName: string): string {
  return `${businessName}: Hi {{FirstName}}, we had you booked in on {{LastVisit}} and never got you back in. Happy to find you a new time whenever suits. Reply here or call us. Reply STOP to opt out.`;
}

export function defaultWinbackEmailSubject(): string {
  return "{{FirstName}}, shall we find you another time?";
}

export function defaultWinbackEmailBody(businessName: string): string {
  return [
    "Hi {{FirstName}},",
    "",
    "We had you booked in with us on {{LastVisit}} and it didn't end up going ahead — no problem at all.",
    "",
    "If you'd still like the work done, just reply to this email and we'll find a time that suits you better. We can usually fit something in within the week.",
    "",
    "Thanks,",
    businessName,
  ].join("\n");
}

/** An auto-generated campaign name, so past sends read as a list of sends. */
export function winbackCampaignName(input: {
  channel: "sms" | "email";
  audienceLabel: string;
  atLabel: string;
}): string {
  return `${input.audienceLabel} ${input.channel === "sms" ? "text" : "email"} · ${input.atLabel}`;
}
