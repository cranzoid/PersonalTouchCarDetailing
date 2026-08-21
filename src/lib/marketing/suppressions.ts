import { and, eq, inArray } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { normalizePhone } from "@/lib/phone";

export type MarketingChannel = "email" | "sms";

export type SuppressionReason = "stop_reply" | "unsubscribe_link" | "manual" | "complaint";

/**
 * The key an opt-out is stored under, and the key every marketing send is
 * checked against.
 *
 * Both sides MUST go through this function. If a send normalized "(905)
 * 555-1234" one way and an inbound STOP normalized it another, the opt-out
 * would sit in the table and never match — the worst possible failure, because
 * it looks like it worked.
 */
export function normalizeDestination(
  channel: MarketingChannel,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (channel === "sms") return normalizePhone(value);
  const email = value.trim().toLowerCase();
  // Not full RFC validation — just enough that we never key a row on something
  // that cannot be an address, which would silently suppress nothing.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Normalized destinations from the given list that must not be messaged. */
export async function findSuppressed(
  tx: Pick<Db, "select">,
  channel: MarketingChannel,
  destinations: readonly string[],
): Promise<Set<string>> {
  const keys = [...new Set(destinations)].filter((d) => d.length > 0);
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ destination: schema.marketingSuppressions.destination })
    .from(schema.marketingSuppressions)
    .where(
      and(
        eq(schema.marketingSuppressions.channel, channel),
        inArray(schema.marketingSuppressions.destination, keys),
      ),
    );
  return new Set(rows.map((r) => r.destination));
}

/** Single-destination check for the gate inside sendMessage(). */
export async function isSuppressed(
  channel: MarketingChannel,
  rawDestination: string,
): Promise<boolean> {
  const destination = normalizeDestination(channel, rawDestination);
  // A destination we cannot normalize is not a destination we can clear, either.
  // Treat it as suppressed rather than sending to something unrecognizable.
  if (!destination) return true;
  return (await findSuppressed(db(), channel, [destination])).size > 0;
}

/**
 * Records an opt-out. Idempotent: a second STOP from the same number is a
 * no-op, so Twilio retrying a webhook delivery cannot produce duplicate rows or
 * duplicate audit noise. Returns true only when this call created the row.
 */
export async function addSuppression(
  tx: Pick<Db, "insert">,
  input: {
    channel: MarketingChannel;
    /** Raw or normalized — normalized here either way. */
    destination: string;
    reason: SuppressionReason;
    source?: string;
    note?: string;
  },
): Promise<boolean> {
  const destination = normalizeDestination(input.channel, input.destination);
  if (!destination) return false;
  const inserted = await tx
    .insert(schema.marketingSuppressions)
    .values({
      id: newId("sup"),
      channel: input.channel,
      destination,
      reason: input.reason,
      source: input.source,
      note: input.note,
    })
    .onConflictDoNothing({
      target: [schema.marketingSuppressions.channel, schema.marketingSuppressions.destination],
    })
    .returning({ id: schema.marketingSuppressions.id });
  return inserted.length > 0;
}

/**
 * Lifts an opt-out — only for an explicit START/UNSTOP reply or a staff member
 * acting on a direct request. Never call this to "clean up" the list.
 */
export async function removeSuppression(
  tx: Pick<Db, "delete">,
  channel: MarketingChannel,
  rawDestination: string,
): Promise<boolean> {
  const destination = normalizeDestination(channel, rawDestination);
  if (!destination) return false;
  const removed = await tx
    .delete(schema.marketingSuppressions)
    .where(
      and(
        eq(schema.marketingSuppressions.channel, channel),
        eq(schema.marketingSuppressions.destination, destination),
      ),
    )
    .returning({ id: schema.marketingSuppressions.id });
  return removed.length > 0;
}
