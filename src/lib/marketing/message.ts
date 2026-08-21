/**
 * Pure message helpers, shared by the server sender and the browser composer.
 *
 * Deliberately free of database and provider imports so the admin composer can
 * run the SAME segment count, merge-field check and send-window rule that the
 * server enforces. A preview computed by different code from the one that sends
 * is a preview that will eventually lie.
 */

/** The only placeholders an outreach body may contain. */
export const OUTREACH_MERGE_FIELDS = ["FirstName", "Company"] as const;

/** Hard ceiling on one "send next N" press. Small on purpose. */
export const MAX_BATCH_SIZE = 25;

export type OutreachMergeValues = { firstName: string; companyName: string };

export function renderOutreachBody(body: string, values: OutreachMergeValues): string {
  const vars: Record<string, string> = { FirstName: values.firstName, Company: values.companyName };
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/**
 * Placeholders in the body that we cannot fill. Catches "{{FirstNarne}}" and
 * "{{BusinessName}}" in the composer instead of in fifty sent messages, where
 * the placeholder renders as an empty string and reads as a broken mail-merge.
 */
export function unknownMergeFields(body: string): string[] {
  const known = new Set<string>(OUTREACH_MERGE_FIELDS);
  const found = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((name) => !known.has(name)))];
}

/* ------------------------------------------------------------------ */
/* SMS segmentation                                                    */
/* ------------------------------------------------------------------ */

const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Characters that fit GSM-7 but cost two septets each. */
const GSM7_EXTENDED = "^{}\\[~]|€";

/**
 * What Twilio will actually bill and what the message will look like on the
 * handset. A single curly quote or em dash — exactly what a word processor
 * produces — drops the whole message to UCS-2 and 70 characters per segment,
 * which can turn a 2-segment message into 5. The composer shows this because
 * the owner is paying per segment, per contact.
 */
export function smsSegments(text: string): {
  characters: number;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
  /** Characters that forced UCS-2, for the "swap these" hint. */
  nonGsmCharacters: string[];
} {
  const nonGsm = [...new Set([...text].filter((c) => !GSM7.includes(c) && !GSM7_EXTENDED.includes(c)))];
  if (nonGsm.length > 0) {
    const units = [...text].length;
    return {
      characters: units,
      segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
      encoding: "UCS-2",
      nonGsmCharacters: nonGsm,
    };
  }
  const septets = [...text].reduce((n, c) => n + (GSM7_EXTENDED.includes(c) ? 2 : 1), 0);
  return {
    characters: septets,
    segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
    encoding: "GSM-7",
    nonGsmCharacters: [],
  };
}

/* ------------------------------------------------------------------ */
/* Send window                                                         */
/* ------------------------------------------------------------------ */

/** Business-local hours a marketing message may go out. */
export const SEND_WINDOW = { startHour: 9, endHour: 20 } as const;

/**
 * Marketing texts at 06:40 or 23:15 read as spam whoever sent them, and CRTC
 * telemarketing rules put the outside edge at 9am–9pm local. This is stricter
 * and is a hard block rather than a warning: the owner writing a campaign late
 * at night is exactly the moment the guard is worth having.
 */
export function withinSendWindow(now: Date, timeZone: string): { allowed: boolean; localHour: number } {
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hour12: false }).format(now),
  ) % 24;
  return { allowed: hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour, localHour: hour };
}
