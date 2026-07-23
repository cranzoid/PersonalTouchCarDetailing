"use client";

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
  | "messages"
  | "services"
  | "staff"
  | "settings";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: AdminNavIcon;
};

/** Active-route-aware navigation shared by the desktop rail and mobile menu. */
export function AdminNavLinks({ items, mobile = false }: { items: AdminNavItem[]; mobile?: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label={mobile ? "Mobile admin navigation" : "Admin navigation"} className={mobile ? "grid grid-cols-2 gap-1.5" : "space-y-1"}>
      {items.map((item) => {
        const active = item.href === "/admin" ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
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
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition ${active ? "bg-[#E0A93B] text-[#0B2A4A]" : mobile ? "bg-[#EEF2F7] text-[#607087] group-hover:text-[#0B2A4A]" : "bg-white/7 text-white/70 group-hover:bg-white/10 group-hover:text-white"}`}>
              <AdminIcon name={item.icon} />
            </span>
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
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
    case "messages":
      return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></svg>;
    case "services":
      return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-3 3-3-3z"/></svg>;
    case "staff":
      return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="m18 4 1 1 2-2"/></svg>;
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
