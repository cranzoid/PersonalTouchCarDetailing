import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { looksLikeOptOutRequest } from "@/lib/marketing/inbound";
import { findSuppressed } from "@/lib/marketing/suppressions";
import { formatPhone } from "@/lib/phone";

/**
 * The replies inbox.
 *
 * Every reply a customer sends has always been recorded — the Twilio webhook
 * writes it into `communications` and applies any opt-out it carries. What was
 * missing was anywhere to READ one: a reply only ever appeared on the customer
 * or lead it happened to match, so finding it meant already knowing it was
 * there. Replies from a number matching neither were effectively invisible.
 *
 * This module turns those rows back into conversations. A conversation is a
 * thread of everything said to and by one contact, in order, and the unit staff
 * actually work in: read it, answer it, move on.
 */

/** A `communications` row, as every screen here needs it. */
export type ReplyMessage = {
  id: string;
  customerId: string | null;
  leadId: string | null;
  direction: string;
  channel: string;
  kind: string;
  status: string;
  subject: string | null;
  body: string;
  contactAddress: string | null;
  contactAddressNormalized: string | null;
  readAt: Date | null;
  createdAt: Date;
  staffName?: string | null;
};

export type ReplyThread = {
  /** Stable within one build — for React keys and client selection only. */
  key: string;
  /** Who the thread is with, as far as the messages themselves say. */
  customerId: string | null;
  leadId: string | null;
  /** The address as it arrived, and the key the thread was gathered on. */
  address: string | null;
  addressNormalized: string | null;
  /** Oldest first: a conversation reads downwards. */
  messages: ReplyMessage[];
  unread: number;
  /** An unread reply that reads like someone asking to be left alone. */
  needsAttention: boolean;
  /** They said STOP. Authoritative value comes from the suppression list. */
  optedOut: boolean;
  lastInboundAt: Date;
  lastMessageAt: Date;
};

type Identity = Pick<ReplyMessage, "customerId" | "leadId" | "contactAddressNormalized">;

/**
 * True when a message and a thread are demonstrably the same conversation.
 *
 * Two known numbers decide it on their own, even for one customer: replying
 * sends to ONE number, so folding a person's work and home phones together
 * would answer whichever of the two the thread happened to keep. Ids bridge
 * only where an address is missing, which is how messages sent before the
 * address was recorded find the thread they belong to.
 */
function sameContact(thread: ReplyThread, row: Identity): boolean {
  if (row.contactAddressNormalized && thread.addressNormalized) {
    return thread.addressNormalized === row.contactAddressNormalized;
  }
  if (row.customerId && thread.customerId === row.customerId) return true;
  if (row.leadId && thread.leadId === row.leadId) return true;
  return false;
}

/**
 * Groups a flat list of messages into conversations.
 *
 * Threads are seeded from INBOUND messages only, deliberately: this is an
 * inbox, and a contact who has never written to us has nothing here to answer.
 * Everything else — the confirmation that prompted the reply, the nudge, the
 * campaign — is then attached to the thread it belongs to, so the reply is read
 * next to what it is replying to.
 *
 * Matching prefers the ADDRESS, then the customer, then the lead. That order
 * matters for a customer with two phones: each number is its own conversation,
 * which is how the person texting from one of them experiences it. Messages
 * sent before the address was recorded have only an id to go on and land on
 * that contact's most recent thread, which is the best available answer.
 */
export function buildReplyThreads(rows: readonly ReplyMessage[]): ReplyThread[] {
  const ascending = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  const threads: ReplyThread[] = [];
  for (const row of ascending) {
    if (row.direction !== "inbound") continue;
    let thread = threads.find((candidate) => sameContact(candidate, row));
    if (!thread) {
      thread = {
        key: row.contactAddressNormalized ?? row.customerId ?? row.leadId ?? row.id,
        customerId: null,
        leadId: null,
        address: null,
        addressNormalized: null,
        messages: [],
        unread: 0,
        needsAttention: false,
        optedOut: false,
        lastInboundAt: row.createdAt,
        lastMessageAt: row.createdAt,
      };
      threads.push(thread);
    }
    // A number that was a bare lead last month and a customer today gains the
    // customer id here rather than splitting into a second conversation.
    thread.customerId ??= row.customerId;
    thread.leadId ??= row.leadId;
    thread.address ??= row.contactAddress;
    thread.addressNormalized ??= row.contactAddressNormalized;
  }

  for (const row of ascending) {
    const thread =
      (row.contactAddressNormalized
        ? threads.find((t) => t.addressNormalized === row.contactAddressNormalized)
        : undefined) ??
      (row.customerId ? findLast(threads, (t) => t.customerId === row.customerId) : undefined) ??
      (row.leadId ? findLast(threads, (t) => t.leadId === row.leadId) : undefined);
    // A message belonging to nobody who has ever written to us is not part of
    // any conversation, and this screen is not the place to show it.
    if (!thread) continue;
    thread.messages.push(row);
    if (row.createdAt > thread.lastMessageAt) thread.lastMessageAt = row.createdAt;
    if (row.direction !== "inbound") continue;

    if (row.createdAt > thread.lastInboundAt) thread.lastInboundAt = row.createdAt;
    if (!row.readAt) {
      thread.unread += 1;
      if (row.kind === "opt_stop" || looksLikeOptOutRequest(row.body)) thread.needsAttention = true;
    }
    // The last opt-out keyword wins: someone who said STOP in March and START
    // in June is opted in, exactly as the suppression list records it.
    if (row.kind === "opt_stop") thread.optedOut = true;
    if (row.kind === "opt_start") thread.optedOut = false;
  }

  return threads.sort((a, b) => b.lastInboundAt.getTime() - a.lastInboundAt.getTime());
}

function findLast<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (test(items[i])) return items[i];
  return undefined;
}

/** Who a thread is with, after resolving the ids and the number on file. */
export type ReplyContact = {
  name: string;
  phoneLabel: string | null;
  customerId: string | null;
  leadId: string | null;
};

export type InboxThread = ReplyThread & { contact: ReplyContact };

/** How far back the inbox looks, and how much of each thread it carries. */
const INBOUND_SCAN_LIMIT = 400;
const THREAD_LIMIT = 80;
const THREAD_MESSAGE_LIMIT = 40;

/**
 * The whole inbox in one read: recent replies, the conversations they belong
 * to, and who each one is with.
 *
 * Loaded in full rather than a thread at a time because the volume is a single
 * shop's texts, and because switching between conversations while working
 * through them should not cost a round trip each.
 */
export async function loadReplyInbox(): Promise<{ threads: InboxThread[]; unread: number }> {
  const columns = {
    id: schema.communications.id,
    customerId: schema.communications.customerId,
    leadId: schema.communications.leadId,
    direction: schema.communications.direction,
    channel: schema.communications.channel,
    kind: schema.communications.kind,
    status: schema.communications.status,
    subject: schema.communications.subject,
    body: schema.communications.body,
    contactAddress: schema.communications.contactAddress,
    contactAddressNormalized: schema.communications.contactAddressNormalized,
    readAt: schema.communications.readAt,
    createdAt: schema.communications.createdAt,
  };

  const inbound = await db()
    .select(columns)
    .from(schema.communications)
    .where(eq(schema.communications.direction, "inbound"))
    .orderBy(desc(schema.communications.createdAt))
    .limit(INBOUND_SCAN_LIMIT);
  if (inbound.length === 0) return { threads: [], unread: 0 };

  const addresses = unique(inbound.map((row) => row.contactAddressNormalized));
  const customerIds = unique(inbound.map((row) => row.customerId));
  const leadIds = unique(inbound.map((row) => row.leadId));

  // Everything else ever said to these same people, so a reply is read beside
  // the message that prompted it.
  const reach: SQL[] = [];
  if (addresses.length > 0) reach.push(inArray(schema.communications.contactAddressNormalized, addresses));
  if (customerIds.length > 0) reach.push(inArray(schema.communications.customerId, customerIds));
  if (leadIds.length > 0) reach.push(inArray(schema.communications.leadId, leadIds));
  const related = await db()
    .select({ ...columns, staffName: schema.staffUsers.name })
    .from(schema.communications)
    .leftJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.communications.createdByStaffId))
    .where(or(...reach))
    .orderBy(desc(schema.communications.createdAt))
    .limit(INBOUND_SCAN_LIMIT * 6);

  const byId = new Map<string, ReplyMessage>();
  for (const row of [...inbound, ...related]) byId.set(row.id, row);

  const threads = buildReplyThreads([...byId.values()]).slice(0, THREAD_LIMIT);
  for (const thread of threads) {
    if (thread.messages.length > THREAD_MESSAGE_LIMIT) {
      thread.messages = thread.messages.slice(-THREAD_MESSAGE_LIMIT);
    }
  }

  const withContacts = await attachContacts(threads);

  // The suppression list, not the message history, is what actually blocks a
  // send — an opt-out added by staff never passed through this inbox at all.
  const suppressed = await findSuppressed(db(), "sms", unique(withContacts.map((t) => t.addressNormalized)));
  for (const thread of withContacts) {
    thread.optedOut = thread.addressNormalized ? suppressed.has(thread.addressNormalized) : thread.optedOut;
  }

  return {
    threads: withContacts,
    unread: withContacts.reduce((total, thread) => total + thread.unread, 0),
  };
}

/** Fills in each thread's contact from the ids on it, then the number on file. */
async function attachContacts(threads: ReplyThread[]): Promise<InboxThread[]> {
  const addresses = unique(threads.map((t) => t.addressNormalized));
  const customerIds = unique(threads.map((t) => t.customerId));
  const leadIds = unique(threads.map((t) => t.leadId));

  // Looked up by number as well as by id, so a reply recorded when the person
  // was only a lead still shows the customer they have since become.
  const customerReach: SQL[] = [];
  if (customerIds.length > 0) customerReach.push(inArray(schema.customers.id, customerIds));
  if (addresses.length > 0) customerReach.push(inArray(schema.customers.phoneNormalized, addresses));
  const leadReach: SQL[] = [];
  if (leadIds.length > 0) leadReach.push(inArray(schema.leads.id, leadIds));
  if (addresses.length > 0) leadReach.push(inArray(schema.leads.phoneNormalized, addresses));

  const [customers, leads] = await Promise.all([
    customerReach.length > 0
      ? db()
          .select({
            id: schema.customers.id,
            firstName: schema.customers.firstName,
            lastName: schema.customers.lastName,
            companyName: schema.customers.companyName,
            phone: schema.customers.phone,
            phoneNormalized: schema.customers.phoneNormalized,
          })
          .from(schema.customers)
          .where(or(...customerReach))
      : [],
    leadReach.length > 0
      ? db()
          .select({
            id: schema.leads.id,
            name: schema.leads.name,
            companyName: schema.leads.companyName,
            phone: schema.leads.phone,
            phoneNormalized: schema.leads.phoneNormalized,
          })
          .from(schema.leads)
          .where(or(...leadReach))
      : [],
  ]);

  const customerById = new Map(customers.map((row) => [row.id, row]));
  const customerByPhone = new Map(
    customers.flatMap((row) => (row.phoneNormalized ? [[row.phoneNormalized, row] as const] : [])),
  );
  const leadById = new Map(leads.map((row) => [row.id, row]));
  const leadByPhone = new Map(
    leads.flatMap((row) => (row.phoneNormalized ? [[row.phoneNormalized, row] as const] : [])),
  );

  for (const thread of threads as InboxThread[]) {
    const customer =
      (thread.customerId ? customerById.get(thread.customerId) : undefined) ??
      (thread.addressNormalized ? customerByPhone.get(thread.addressNormalized) : undefined);
    const lead =
      (thread.leadId ? leadById.get(thread.leadId) : undefined) ??
      (thread.addressNormalized ? leadByPhone.get(thread.addressNormalized) : undefined);

    const customerName = customer
      ? customer.companyName || `${customer.firstName} ${customer.lastName}`.trim()
      : null;
    thread.contact = {
      name: customerName || lead?.companyName || lead?.name || formatPhone(thread.address) || "Unknown number",
      phoneLabel: formatPhone(thread.address ?? customer?.phone ?? lead?.phone) || null,
      // A reply that arrived while they were still a lead, from someone who has
      // since become a customer, links to both records.
      customerId: customer?.id ?? null,
      leadId: lead?.id ?? null,
    };
  }
  return threads as InboxThread[];
}

export type UnreadReply = {
  id: string;
  name: string;
  phoneLabel: string | null;
  preview: string;
  createdAt: Date;
  needsAttention: boolean;
};

/** Count alone, for the badge that has to be cheap on every admin page load. */
export async function countUnreadReplies(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.communications)
    .where(and(eq(schema.communications.direction, "inbound"), isNull(schema.communications.readAt)));
  return row?.n ?? 0;
}

/**
 * The newest unread replies, named, for the dashboard.
 *
 * A list rather than a number, for the same reason the attention queue is one:
 * a count nobody can act on gets ignored, and the point of this card is that
 * somebody is waiting for an answer.
 */
export async function loadUnreadReplies(limit = 5): Promise<{ total: number; items: UnreadReply[] }> {
  const total = await countUnreadReplies();
  if (total === 0) return { total: 0, items: [] };

  const rows = await db()
    .select({
      id: schema.communications.id,
      body: schema.communications.body,
      kind: schema.communications.kind,
      contactAddress: schema.communications.contactAddress,
      createdAt: schema.communications.createdAt,
      customerFirstName: schema.customers.firstName,
      customerLastName: schema.customers.lastName,
      customerCompany: schema.customers.companyName,
      leadName: schema.leads.name,
      leadCompany: schema.leads.companyName,
    })
    .from(schema.communications)
    .leftJoin(schema.customers, eq(schema.customers.id, schema.communications.customerId))
    .leftJoin(schema.leads, eq(schema.leads.id, schema.communications.leadId))
    .where(and(eq(schema.communications.direction, "inbound"), isNull(schema.communications.readAt)))
    .orderBy(desc(schema.communications.createdAt))
    .limit(limit);

  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      name:
        row.customerCompany ||
        `${row.customerFirstName ?? ""} ${row.customerLastName ?? ""}`.trim() ||
        row.leadCompany ||
        row.leadName ||
        formatPhone(row.contactAddress) ||
        "Unknown number",
      phoneLabel: formatPhone(row.contactAddress) || null,
      preview: row.body.length > 140 ? `${row.body.slice(0, 140)}…` : row.body,
      createdAt: row.createdAt,
      needsAttention: row.kind === "opt_stop" || looksLikeOptOutRequest(row.body),
    })),
  };
}

/**
 * The two reads the admin shell does whether anybody asked for them or not,
 * degraded rather than fatal.
 *
 * The count is in the rail on every admin page and the card opens the
 * dashboard, so a throw here takes down screens that have nothing to do with
 * replies. The one window where either can fail is a release: the staging slot
 * shares the production database and migrates at boot, so for a few seconds the
 * live build is querying a schema mid-change. A rail without a number on it, or
 * a dashboard without the card, beats a shop that cannot see today's work.
 *
 * The replies screen itself is deliberately NOT wrapped. If the data is broken
 * that screen should say so rather than quietly show an empty inbox.
 */
export async function unreadReplyCountOrZero(): Promise<number> {
  try {
    return await countUnreadReplies();
  } catch (error) {
    console.error("[replies] unread count unavailable", error instanceof Error ? error.message : "");
    return 0;
  }
}

/** As above, for the dashboard card. Null means "show nothing", not "none". */
export async function unreadRepliesOrNone(
  limit?: number,
): Promise<{ total: number; items: UnreadReply[] } | null> {
  try {
    return await loadUnreadReplies(limit);
  } catch (error) {
    console.error("[replies] unread replies unavailable", error instanceof Error ? error.message : "");
    return null;
  }
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
