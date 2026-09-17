"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type AdminNavIcon =
  | "dashboard"
  | "calendar"
  | "leads"
  | "estimate"
  | "jobs"
  | "invoice"
  | "customers"
  | "fleet"
  | "reports"
  | "expenses"
  | "messages"
  | "megaphone"
  | "blog"
  | "services"
  | "staff"
  | "settings"
  | "ticket"
  | "claims";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: AdminNavIcon;
};

export type AdminNavSection = {
  label: string;
  items: AdminNavItem[];
};

/**
 * Nested routes such as /admin/reports/payroll match both "Reports" and
 * "Payroll". Prefer the most specific destination so the navigation always
 * communicates exactly one current location.
 */
function activeHrefFor(sections: AdminNavSection[], pathname: string): string | undefined {
  return sections
    .flatMap((section) => section.items)
    .filter((item) => (item.href === "/admin" ? pathname === item.href : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/**
 * The admin rail, as collapsible groups.
 *
 * Every release has added another destination and the flat list had grown past
 * a laptop screen, so reaching Settings meant scrolling past nine things nobody
 * on the counter uses. Sections now collapse, and only the one holding the
 * current page is open — which keeps the whole rail visible without scrolling
 * and makes the grouping do some work rather than just labelling a long list.
 *
 * Open/closed is deliberately NOT persisted. The sidebar lives in the layout,
 * so a section a staff member opens stays open for the rest of the visit; what
 * survives a reload is the rule, not one person's leftover state.
 */
export function AdminNav({
  sections,
  mobile = false,
}: {
  sections: AdminNavSection[];
  mobile?: boolean;
}) {
  const pathname = usePathname();
  const activeHref = activeHrefFor(sections, pathname);
  const activeSection = sections.find((section) =>
    section.items.some((item) => item.href === activeHref),
  )?.label;

  const [open, setOpen] = useState<string[]>(() => (activeSection ? [activeSection] : []));

  // Navigating into a collapsed section opens it. Without this, following a
  // link from inside a page — "Redeem a code" from the nudges screen, say —
  // would leave the rail pointing nowhere.
  useEffect(() => {
    if (activeSection) setOpen((prev) => (prev.includes(activeSection) ? prev : [...prev, activeSection]));
  }, [activeSection]);

  return (
    <nav aria-label={mobile ? "Mobile admin navigation" : "Admin navigation"} className="space-y-1">
      {sections.map((section) => {
        const expanded = open.includes(section.label);
        const holdsActive = section.label === activeSection;
        return (
          <section key={section.label}>
            <h2>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((prev) =>
                    prev.includes(section.label)
                      ? prev.filter((label) => label !== section.label)
                      : [...prev, section.label],
                  )
                }
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-[10px] font-bold uppercase tracking-[0.18em] outline-none transition focus-visible:ring-2 focus-visible:ring-[#E0A93B] ${
                  mobile
                    ? "text-[#5A6B7D] hover:bg-[#F4F6FA] hover:text-[#0B2A4A]"
                    : "text-white/45 hover:bg-white/8 hover:text-white/75"
                }`}
              >
                <Chevron open={expanded} />
                <span className="truncate">{section.label}</span>
                {/* A collapsed section still has to say "you are in here". */}
                {holdsActive && !expanded && (
                  <span
                    aria-hidden="true"
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[#E0A93B]"
                  />
                )}
                <span className="sr-only">{holdsActive ? "(contains the current page)" : ""}</span>
              </button>
            </h2>
            {expanded && (
              <ul className={mobile ? "mt-1 mb-2 grid gap-1 sm:grid-cols-2" : "mt-1 mb-2 space-y-1"}>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <AdminNavLink item={item} active={item.href === activeHref} mobile={mobile} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}

function AdminNavLink({
  item,
  active,
  mobile,
}: {
  item: AdminNavItem;
  active: boolean;
  mobile: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[#E0A93B] ${
        active
          ? mobile
            ? "bg-[#0B2A4A] text-[#FFFFFF] shadow-sm"
            : "bg-white/12 text-[#FFFFFF] shadow-[inset_3px_0_0_#E0A93B]"
          : mobile
            ? "text-[#445468] hover:bg-[#F4F6FA] hover:text-[#0B2A4A]"
            : "text-white/65 hover:bg-white/8 hover:text-white"
      }`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition ${
          active
            ? "bg-[#E0A93B] text-[#0B2A4A]"
            : mobile
              ? "bg-[#EEF2F7] text-[#5A6B7D] group-hover:text-[#0B2A4A]"
              : "bg-white/7 text-white/70 group-hover:bg-white/10 group-hover:text-white"
        }`}
      >
        <AdminIcon name={item.icon} />
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function AdminIcon({ name }: { name: AdminNavIcon }) {
  const common = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "dashboard":
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
    case "calendar":
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>;
    case "leads":
      return <svg {...common}><path d="M12 3a6 6 0 0 0-3.7 10.7c.8.6 1.2 1.3 1.2 2.3h5c0-1 .4-1.7 1.2-2.3A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10.5 22h3"/></svg>;
    case "estimate":
      return <svg {...common}><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>;
    case "jobs":
      return <svg {...common}><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12h18M10 12v2h4v-2"/></svg>;
    case "invoice":
      return <svg {...common}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>;
    case "customers":
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "fleet":
      return <svg {...common}><path d="M5 17h14l2-5-2-5H5l-2 5z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M5 7l2-3h10l2 3M3 12h18"/></svg>;
    case "reports":
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>;
    case "expenses":
      return <svg {...common}><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/><path d="M18 3H8a2 2 0 0 0-2 2v1"/></svg>;
    case "messages":
      return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></svg>;
    case "blog":
      return <svg {...common}><path d="M5 3h11l3 3v15H5z"/><path d="M14 3v5h5M8 12h8M8 16h8M8 8h2"/></svg>;
    case "services":
      return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-3 3-3-3z"/></svg>;
    case "staff":
      return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="m18 4 1 1 2-2"/></svg>;
    case "ticket":
      return <svg {...common}><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" strokeDasharray="2 2"/></svg>;
    case "megaphone":
      return <svg {...common}><path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M14 9a4 4 0 0 1 0 6"/><path d="M17 6a8 8 0 0 1 0 12"/></svg>;
    case "claims":
      return <svg {...common}><path d="M20 12.5 12.5 20a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l5.9 5.9a2 2 0 0 1 0 2.8Z"/><path d="M7.5 7.5h.01"/></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>;
  }
}

export function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, string> = {
    confirmed: "border-emerald-200 bg-emerald-50 text-emerald-700",
    pending: "border-amber-200 bg-amber-50 text-amber-700",
    deposit_required: "border-amber-200 bg-amber-50 text-amber-700",
    arrived: "border-sky-200 bg-sky-50 text-sky-700",
    cancelled: "border-red-200 bg-red-50 text-red-700",
    no_show: "border-red-200 bg-red-50 text-red-700",
    completed: "border-slate-200 bg-slate-100 text-slate-700",
    converted: "border-violet-200 bg-violet-50 text-violet-700",
    rescheduled: "border-sky-200 bg-sky-50 text-sky-700",
    new: "border-amber-200 bg-amber-50 text-amber-700",
    contacted: "border-sky-200 bg-sky-50 text-sky-700",
    qualified: "border-emerald-200 bg-emerald-50 text-emerald-700",
    lost: "border-slate-200 bg-slate-100 text-slate-600",
    reviewing: "border-sky-200 bg-sky-50 text-sky-700",
    estimated: "border-emerald-200 bg-emerald-50 text-emerald-700",
    closed: "border-slate-200 bg-slate-100 text-slate-600",
    draft: "border-slate-200 bg-slate-100 text-slate-700",
    sent: "border-blue-200 bg-blue-50 text-blue-700",
    viewed: "border-blue-200 bg-blue-50 text-blue-700",
    changes_requested: "border-amber-200 bg-amber-50 text-amber-700",
    approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
    declined: "border-red-200 bg-red-50 text-red-700",
    expired: "border-slate-200 bg-slate-100 text-slate-600",
    checked_in: "border-sky-200 bg-sky-50 text-sky-700",
    inspection: "border-amber-200 bg-amber-50 text-amber-700",
    awaiting_approval: "border-amber-200 bg-amber-50 text-amber-700",
    ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
    in_progress: "border-blue-200 bg-blue-50 text-blue-700",
    paused: "border-slate-200 bg-slate-100 text-slate-700",
    quality_check: "border-violet-200 bg-violet-50 text-violet-700",
    correction_required: "border-red-200 bg-red-50 text-red-700",
    ready_for_pickup: "border-emerald-200 bg-emerald-50 text-emerald-700",
    override_approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
    paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
    partially_paid: "border-amber-200 bg-amber-50 text-amber-700",
    overdue: "border-red-200 bg-red-50 text-red-700",
    refunded: "border-violet-200 bg-violet-50 text-violet-700",
    succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
    failed: "border-red-200 bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize leading-none ${tones[status] ?? "border-slate-200 bg-slate-100 text-slate-700"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {status.replaceAll("_", " ")}
    </span>
  );
}
