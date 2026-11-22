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
/* One status for a lead and its requests                              */
/* ------------------------------------------------------------------ */

/**
 * The lead's status is the only status staff see. A quote or callback request
 * keeps a status column of its own (new | reviewing | estimated | closed), but
 * it is a mirror, rewritten from the lead's by `quoteStatusForLead` whenever the
 * lead moves, so the Leads list and a request's call log can never disagree.
 */
export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "completed", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Finished with: nothing more to chase. */
export function isLeadClosed(status: string): boolean {
  return status === "completed" || status === "lost";
}

/** The request status that mirrors a lead status. */
export function quoteStatusForLead(
  leadStatus: string,
  hasEstimate: boolean,
): "new" | "reviewing" | "estimated" | "closed" {
  if (isLeadClosed(leadStatus)) return "closed";
  if (leadStatus === "new") return "new";
  return hasEstimate ? "estimated" : "reviewing";
}

export const LEAD_FILTERS = ["all", "new", "due", "contacted", "qualified", "converted", "completed", "lost"] as const;
export type LeadFilter = (typeof LEAD_FILTERS)[number];

export const LEAD_FILTER_LABELS: Record<LeadFilter, string> = {
  all: "All",
  new: "New — not called",
  due: "Follow-up due",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  completed: "Completed",
  lost: "Lost",
};

export function parseLeadFilter(value: string | undefined): LeadFilter {
  return (LEAD_FILTERS as readonly string[]).includes(value ?? "") ? (value as LeadFilter) : "all";
}

export function parseTopic(value: string | undefined): LeadTopic | null {
  return (LEAD_TOPICS as readonly string[]).includes(value ?? "") ? (value as LeadTopic) : null;
}

type ListedLead = { status: string; nextFollowUpAt: Date | null };

/**
 * A follow-up has come due on someone already spoken to. A new lead is not
 * counted: it is waiting for its first call, which the New chip already shows.
 */
export function isFollowUpDueFor(lead: ListedLead, now: Date): boolean {
  return (
    lead.status !== "new" &&
    !isLeadClosed(lead.status) &&
    lead.nextFollowUpAt !== null &&
    lead.nextFollowUpAt <= now
  );
}

export function matchesLeadFilter(lead: ListedLead, filter: LeadFilter, now: Date): boolean {
  if (filter === "all") return true;
  if (filter === "due") return isFollowUpDueFor(lead, now);
  return lead.status === filter;
}

/** "Not called yet", or "Contacted Nov 3 · 2 follow-ups". */
export function callStatusLabel(
  request: { lastFollowedUpAt: Date | null },
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
