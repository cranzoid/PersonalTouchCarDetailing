/**
 * What a lead or quote request is about, and where it stands in the call queue.
 *
 * Pure and client-safe: the Leads screen sorts and counts with these, and the
 * follow-up wording reads the topic, so there is one definition of each.
 *
 * Nothing here is stored. A topic is worked out from what the lead already
 * carries — its `kind` and the `enquiryType` the public form stamped into its
 * attribution — so old rows get a topic too and no migration is involved.
 */

export const LEAD_TOPICS = [
  "ceramic_callback",
  "dash_cam",
  "festive_coating",
  "first_wash",
  "general_quote",
  "fleet",
  "contact",
] as const;

export type LeadTopic = (typeof LEAD_TOPICS)[number];

export const LEAD_TOPIC_LABELS: Record<LeadTopic, string> = {
  ceramic_callback: "Ceramic callback",
  dash_cam: "Dash cam",
  festive_coating: "Festive coating",
  first_wash: "First wash",
  general_quote: "General quote",
  fleet: "Fleet",
  contact: "Contact",
};

/** Badge colours, as Tailwind classes, so each topic reads at a glance. */
export const LEAD_TOPIC_TONES: Record<LeadTopic, string> = {
  ceramic_callback: "border-sky-200 bg-sky-50 text-sky-700",
  dash_cam: "border-violet-200 bg-violet-50 text-violet-700",
  festive_coating: "border-orange-200 bg-orange-50 text-orange-700",
  first_wash: "border-emerald-200 bg-emerald-50 text-emerald-700",
  general_quote: "border-slate-200 bg-slate-100 text-slate-700",
  fleet: "border-amber-200 bg-amber-50 text-amber-700",
  contact: "border-slate-200 bg-slate-100 text-slate-700",
};

/** `attribution.enquiryType` values the public forms write. */
export const ENQUIRY_TYPES = {
  ceramicCallback: "ceramic_callback",
  dashCam: "dash_cam",
  festiveCoating: "festive_coating_qr",
} as const;

function enquiryTypeOf(attribution: unknown): string | null {
  if (typeof attribution !== "object" || attribution === null) return null;
  const value = (attribution as Record<string, unknown>).enquiryType;
  return typeof value === "string" ? value : null;
}

export function leadTopic(lead: { kind: string; attribution: unknown }): LeadTopic {
  switch (enquiryTypeOf(lead.attribution)) {
    case ENQUIRY_TYPES.ceramicCallback:
      return "ceramic_callback";
    case ENQUIRY_TYPES.dashCam:
      return "dash_cam";
    case ENQUIRY_TYPES.festiveCoating:
      return "festive_coating";
  }
  // The new-customer wash is the only thing that writes an "offer" lead.
  if (lead.kind === "offer") return "first_wash";
  if (lead.kind === "fleet") return "fleet";
  if (lead.kind === "quote") return "general_quote";
  return "contact";
}

/** What a follow-up says the person asked about, when no service was attached. */
export function topicServicesLabel(topic: LeadTopic | undefined): string {
  switch (topic) {
    case "ceramic_callback":
      return "ceramic protection";
    case "dash_cam":
      return "dash cam installation";
    case "festive_coating":
      return "ceramic coating";
    default:
      return "detailing";
  }
}

/* ------------------------------------------------------------------ */
/* The call queue                                                      */
/* ------------------------------------------------------------------ */

export const REQUEST_FILTERS = ["all", "call", "due", "contacted", "closed"] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

export const REQUEST_FILTER_LABELS: Record<RequestFilter, string> = {
  all: "All",
  call: "Needs a call",
  due: "Follow-up due",
  contacted: "Contacted",
  closed: "Closed",
};

export function parseRequestFilter(value: string | undefined): RequestFilter {
  return (REQUEST_FILTERS as readonly string[]).includes(value ?? "") ? (value as RequestFilter) : "all";
}

export function parseTopic(value: string | undefined): LeadTopic | null {
  return (LEAD_TOPICS as readonly string[]).includes(value ?? "") ? (value as LeadTopic) : null;
}

type QueueRequest = {
  status: string;
  createdAt: Date;
  lastFollowedUpAt: Date | null;
  nextFollowUpAt: Date | null;
};

/**
 * "Called" means a follow-up has been logged against the request, which is
 * also what moves the lead from new to contacted. The app keeps no separate
 * "seen it" marker, so opening a request does not count.
 */
export function needsCall(request: QueueRequest): boolean {
  return request.status !== "closed" && request.lastFollowedUpAt === null;
}

export function isContacted(request: QueueRequest): boolean {
  return request.status !== "closed" && request.lastFollowedUpAt !== null;
}

export function isDue(request: QueueRequest, now: Date): boolean {
  return request.status !== "closed" && request.nextFollowUpAt !== null && request.nextFollowUpAt <= now;
}

export function matchesRequestFilter(request: QueueRequest, filter: RequestFilter, now: Date): boolean {
  switch (filter) {
    case "all":
      return true;
    case "call":
      return needsCall(request);
    case "due":
      return isDue(request, now);
    case "contacted":
      return isContacted(request);
    case "closed":
      return request.status === "closed";
  }
}

/**
 * The order somebody works the list in: requests nobody has called first, the
 * longest-waiting at the top; then follow-ups that have come due; then the rest
 * of the contacted ones, newest first; closed last.
 */
export function sortForCalling<T extends QueueRequest>(requests: readonly T[], now: Date): T[] {
  const rank = (r: T) => (r.status === "closed" ? 3 : needsCall(r) ? 0 : isDue(r, now) ? 1 : 2);
  return [...requests].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    switch (rank(a)) {
      case 0:
        return a.createdAt.getTime() - b.createdAt.getTime();
      case 1:
        return (a.nextFollowUpAt?.getTime() ?? 0) - (b.nextFollowUpAt?.getTime() ?? 0);
      default:
        return b.createdAt.getTime() - a.createdAt.getTime();
    }
  });
}

const DAY_MS = 86_400_000;

/** "Waiting 3 days", or "Waiting since today" for one that arrived in the last day. */
export function waitingLabel(createdAt: Date, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS));
  if (days === 0) return "Waiting since today";
  return `Waiting ${days} day${days === 1 ? "" : "s"}`;
}

/** "Not called yet", or "Contacted Nov 3 · 2 follow-ups". */
export function callStatusLabel(
  request: Pick<QueueRequest, "status" | "lastFollowedUpAt">,
  followUps: number,
  formatDay: (date: Date) => string,
): string {
  if (request.lastFollowedUpAt === null) return "Not called yet";
  const count = Math.max(followUps, 1);
  return `Contacted ${formatDay(request.lastFollowedUpAt)} · ${count} follow-up${count === 1 ? "" : "s"}`;
}

/** A phone number as a `tel:` href: digits and a leading plus only. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? `tel:${cleaned}` : null;
}
