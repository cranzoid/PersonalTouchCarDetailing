import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { card, heading, subtle } from "../ui";
import { SuppressionManager } from "./suppression-manager";

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<string, string> = {
  stop_reply: "Replied STOP",
  unsubscribe_link: "Used the unsubscribe link",
  manual: "Added by staff",
  complaint: "Complaint",
};

export default async function DoNotContactPage() {
  await requirePageStaff("manage_marketing");
  const settings = await getSettings();

  const entries = await db()
    .select()
    .from(schema.marketingSuppressions)
    .orderBy(desc(schema.marketingSuppressions.createdAt))
    .limit(500);

  return (
    <div className="max-w-[70rem]">
      <header>
        <Link href="/admin/marketing" className="text-xs font-semibold text-[#8A681F] hover:underline">
          ← All campaigns
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Do-not-contact list</h1>
        <p className={`mt-1 ${subtle}`}>
          Nobody on this list receives marketing from either channel, on any campaign, ever again.
          Confirmations, invoices and receipts for work they book are not affected.
        </p>
      </header>

      <div className="mt-6">
        <SuppressionManager
          entries={entries.map((entry) => ({
            id: entry.id,
            channel: entry.channel as "email" | "sms",
            destination: entry.channel === "sms" ? formatPhone(entry.destination) : entry.destination,
            rawDestination: entry.destination,
            reason: REASON_LABELS[entry.reason] ?? entry.reason,
            note: entry.note,
            addedAt: formatInZone(entry.createdAt, settings.timezone, {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
          }))}
        />
      </div>

      {entries.length === 0 && (
        <p className={`mt-6 ${card} text-center text-sm text-[#687B8E]`}>
          <span className={`block ${heading}`}>Nobody has opted out</span>
          <span className="mt-1 block">STOP replies and unsubscribes will appear here automatically.</span>
        </p>
      )}
    </div>
  );
}
