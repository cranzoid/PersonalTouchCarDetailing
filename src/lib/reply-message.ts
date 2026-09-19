/**
 * The client-safe half of the replies inbox: the limits and the wording the
 * composer and the thread view both need.
 *
 * Deliberately free of database and `server-only` imports, so the browser
 * bundle can have it without dragging src/lib/replies.ts (and with it the whole
 * schema) along.
 */

/**
 * How long a typed reply may be: four segments. Long enough for a real answer,
 * short enough that nobody writes an essay into a text without noticing what it
 * costs — the composer shows the live segment count beside it.
 */
export const REPLY_SMS_LIMIT = 640;

/**
 * What a message was, in the words the shop uses. The `kind` column carries the
 * automation's name for it ("deposit_reminder"), which is fine in a database
 * and wrong on a screen somebody reads forty times a day.
 */
export function describeMessage(message: { direction: string; kind: string }): string {
  if (message.direction === "inbound") {
    if (message.kind === "opt_stop") return "Replied STOP";
    if (message.kind === "opt_start") return "Opted back in";
    return "Their reply";
  }
  if (message.kind === "manual") return "Your reply";
  if (message.kind === "marketing") return "Outreach";
  if (message.kind === "staff_alert") return "Internal alert";
  return message.kind.replaceAll("_", " ");
}
