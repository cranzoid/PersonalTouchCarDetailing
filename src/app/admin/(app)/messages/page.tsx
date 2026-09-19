import { requirePageStaff } from "@/lib/auth/page";
import { outreachProviderReady } from "@/lib/marketing/winback";
import { describeMessage } from "@/lib/reply-message";
import { loadReplyInbox } from "@/lib/replies";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { RepliesInbox, type ThreadMessageView, type ThreadView } from "./replies-inbox";

export const dynamic = "force-dynamic";

/**
 * Replies.
 *
 * Every text a customer has sent back, as conversations rather than as rows
 * buried on whichever record they happened to match. Before this screen the
 * only way to see a reply was to already suspect it existed and go looking on
 * the customer — and a reply from a number belonging to no record at all could
 * not be found from anywhere.
 *
 * One read, whole inbox, no filter in the URL: unlike the campaign screens
 * nothing here changes the database query, and flicking between conversations
 * while working through the morning's texts should not cost a round trip each.
 */
export default async function RepliesPage() {
  await requirePageStaff("manage_customers");
  const settings = await getSettings();
  const tz = settings.timezone;

  const [{ threads }, smsReady] = await Promise.all([loadReplyInbox(), outreachProviderReady("sms")]);

  const time = (at: Date) =>
    formatInZone(at, tz, { hour: "numeric", minute: "2-digit" });
  const day = (at: Date) =>
    formatInZone(at, tz, { weekday: "long", month: "long", day: "numeric" });
  const stamp = (at: Date) =>
    formatInZone(at, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const views: ThreadView[] = threads.map((thread) => {
    const messages: ThreadMessageView[] = thread.messages.map((message) => ({
      id: message.id,
      direction: message.direction === "inbound" ? "inbound" : "outbound",
      channel: message.channel,
      label: describeMessage(message),
      subject: message.subject,
      body: message.body,
      status: message.status,
      timeLabel: time(message.createdAt),
      dayLabel: day(message.createdAt),
      staffName: message.staffName ?? null,
      unread: message.direction === "inbound" && !message.readAt,
    }));
    const last = thread.messages[thread.messages.length - 1];
    return {
      key: thread.key,
      name: thread.contact.name,
      phoneLabel: thread.contact.phoneLabel,
      address: thread.address,
      customerId: thread.contact.customerId,
      leadId: thread.contact.leadId,
      unread: thread.unread,
      needsAttention: thread.needsAttention,
      optedOut: thread.optedOut,
      lastAtLabel: stamp(thread.lastMessageAt),
      lastPreview: last ? preview(last.body) : "",
      lastFromThem: last?.direction === "inbound",
      // A conversation whose number never made it onto any row cannot be
      // answered or marked read — both actions are keyed on the number.
      canReply: Boolean(thread.address),
      messages,
    };
  });

  return (
    <div className="max-w-[92rem]">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Replies</p>
        <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">What customers have texted back</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-[#5A6B7D]">
          Every reply to a confirmation, a reminder or a campaign, with the whole thread underneath
          it. Open one to read it and answer by text — the reply is saved to their record like any
          other message. Anyone who replied STOP is shown but cannot be texted.
        </p>
      </header>

      <div className="mt-6">
        <RepliesInbox threads={views} smsReady={smsReady} />
      </div>
    </div>
  );
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}
