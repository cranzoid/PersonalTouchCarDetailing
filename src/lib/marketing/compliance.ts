import type { BusinessSettings } from "@/lib/settings";

/**
 * CASL, in the two places it actually bites.
 *
 * Canada's anti-spam law requires every commercial electronic message to carry
 * (a) who sent it, including a mailing address and one more contact method, and
 * (b) a working way to opt out. That applies to SMS as much as to email.
 *
 * The email footer is APPENDED BY THE SYSTEM rather than left to the campaign
 * body, because a footer the owner has to remember is a footer that will be
 * missing from the one campaign nobody proofread. SMS has no room for a footer,
 * so there the opt-out line is enforced as a validation rule instead.
 */

export function emailComplianceFooter(
  settings: Pick<
    BusinessSettings,
    "businessName" | "addressLine1" | "city" | "province" | "postalCode" | "phone" | "email"
  >,
  unsubscribeLink: string,
): string {
  const address = [
    settings.addressLine1,
    [settings.city, settings.province].filter(Boolean).join(", "),
    settings.postalCode,
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(", ");
  return [
    "",
    "—",
    settings.businessName,
    address,
    [settings.phone, settings.email].filter(Boolean).join(" · "),
    "",
    "You are receiving this because we met and exchanged contact details.",
    `Unsubscribe: ${unsubscribeLink}`,
  ].join("\n");
}

/** Opt-out instructions we accept as satisfying (b) in an SMS body. */
const SMS_OPT_OUT_PATTERN = /\bSTOP\b/i;

export type ComplianceIssue = { level: "error" | "warning"; message: string };

/**
 * Checks a campaign body before it can be sent. Errors block the send;
 * warnings are shown next to the send button and can be overridden by a person
 * who can see the whole message and decide.
 */
export function checkCampaignCompliance(input: {
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  businessName: string;
}): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const body = input.body.trim();

  if (body.length === 0) {
    issues.push({ level: "error", message: "The message body is empty." });
    return issues;
  }

  if (input.channel === "sms") {
    if (!SMS_OPT_OUT_PATTERN.test(body)) {
      issues.push({
        level: "error",
        message:
          'The text must tell people how to opt out — include "Reply STOP to opt out". This is required by CASL and the message cannot be sent without it.',
      });
    }
    if (!mentionsSender(body, input.businessName)) {
      issues.push({
        level: "warning",
        message: `The text does not appear to name ${input.businessName}. CASL requires the sender to be identified.`,
      });
    }
    // 3 segments is roughly the point where a message reads as an essay on a
    // phone and the per-contact cost stops being trivial.
    if (body.length > 480) {
      issues.push({ level: "warning", message: "This is a long text — consider trimming it." });
    }
  }

  if (input.channel === "email") {
    if (!input.subject || input.subject.trim().length === 0) {
      issues.push({ level: "error", message: "Email campaigns need a subject line." });
    }
    if (input.subject && input.subject.length > 120) {
      issues.push({ level: "warning", message: "Subject lines over about 60 characters get truncated in most inboxes." });
    }
  }

  return issues;
}

/** Loose check — matches "Personal Touch" as well as the full trading name. */
function mentionsSender(body: string, businessName: string): boolean {
  const haystack = body.toLowerCase();
  const words = businessName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return true;
  return words.some((word) => haystack.includes(word));
}
