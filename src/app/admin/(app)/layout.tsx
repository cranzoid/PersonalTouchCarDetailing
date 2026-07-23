import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNavLinks, type AdminNavIcon } from "@/components/admin";
import { getStaff } from "@/lib/auth/session";
import { roleHas, type Permission } from "@/lib/auth/permissions";
import { logoutAction } from "../login/actions";

type NavItem = { href: string; label: string; permission: Permission; icon: AdminNavIcon };

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/admin", label: "Dashboard", permission: "view_dashboard", icon: "dashboard" },
    ],
  },
  {
    label: "Workflow",
    items: [
      { href: "/admin/appointments", label: "Appointments", permission: "manage_bookings", icon: "calendar" },
      { href: "/admin/leads", label: "Leads", permission: "manage_customers", icon: "leads" },
      { href: "/admin/estimates", label: "Estimates", permission: "manage_estimates", icon: "estimate" },
      { href: "/admin/jobs", label: "Jobs", permission: "work_jobs", icon: "jobs" },
    ],
  },
  {
    label: "Clients & revenue",
    items: [
      { href: "/admin/invoices", label: "Invoices", permission: "record_payments", icon: "invoice" },
      { href: "/admin/customers", label: "Customers", permission: "manage_customers", icon: "customers" },
      { href: "/admin/fleet", label: "Fleet accounts", permission: "manage_customers", icon: "fleet" },
      { href: "/admin/reports", label: "Reports", permission: "view_financial_reports", icon: "reports" },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/admin/communications", label: "Messages", permission: "manage_settings", icon: "messages" },
      { href: "/admin/services", label: "Services", permission: "manage_services", icon: "services" },
      { href: "/admin/staff", label: "Staff", permission: "manage_staff", icon: "staff" },
      { href: "/admin/settings", label: "Settings", permission: "manage_settings", icon: "settings" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Layout-level gate for UX; every server action independently re-checks
  // authorization via requireStaff() — this redirect is not the security boundary.
  const staff = await getStaff();
  if (!staff) redirect("/admin/login");
  const visibleSections = NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items
      .filter((item) => roleHas(staff.role, item.permission))
      .map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((section) => section.items.length > 0);
  const visibleNav = visibleSections.flatMap((section) => section.items);
  const initial = staff.name.trim().charAt(0).toUpperCase() || "S";

  return (
    <div className="admin-shell min-h-screen bg-[#F4F6FA] text-[#1C2026]">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[17rem] shrink-0 flex-col overflow-y-auto bg-[#0B2A4A] px-4 py-5 shadow-[12px_0_40px_rgba(11,42,74,0.08)] lg:flex">
          <BrandLockup />

          <div className="mt-7 flex-1">
            {visibleSections.map((section) => (
              <section key={section.label} className="mb-5">
                <p className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.22em] text-white/38">
                  {section.label}
                </p>
                <AdminNavLinks items={section.items} />
              </section>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.06] p-3.5">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#E0A93B] text-sm font-bold text-[#0B2A4A] shadow-sm">{initial}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[#FFFFFF]">{staff.name}</span>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{staff.role}</span>
              </span>
            </div>
            <form action={logoutAction} className="mt-3 border-t border-white/10 pt-3">
              <button className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium text-white/55 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-[#E0A93B]">
                Sign out
                <span aria-hidden="true">↗</span>
              </button>
            </form>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-40 flex h-[4.5rem] items-center justify-between border-b border-[#DDE4EC] bg-white/95 px-4 backdrop-blur md:px-7 lg:px-9">
            <div className="lg:hidden">
              <BrandLockup compact />
            </div>
            <div className="hidden lg:block">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#77869A]">Personal Touch</p>
              <p className="mt-0.5 text-sm font-semibold text-[#0B2A4A]">Operations workspace</p>
            </div>

            <div className="flex items-center gap-2.5">
              <a href="/" target="_blank" rel="noopener noreferrer" className="hidden min-h-10 items-center gap-2 rounded-xl border border-[#D9E1EA] bg-white px-3.5 text-xs font-semibold text-[#42536A] shadow-sm outline-none transition hover:border-[#0B2A4A]/30 hover:text-[#0B2A4A] focus-visible:ring-2 focus-visible:ring-[#E0A93B] sm:flex">
                View website <span aria-hidden="true">↗</span>
              </a>

              <details className="group relative lg:hidden">
                <summary className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-xl bg-[#0B2A4A] text-[#FFFFFF] shadow-sm outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-[#E0A93B]" aria-label="Open admin menu">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
                </summary>
                <div className="absolute right-0 top-12 w-[min(23rem,calc(100vw-2rem))] rounded-2xl border border-[#DDE4EC] bg-white p-3 shadow-[0_22px_60px_rgba(11,42,74,0.18)]">
                  <div className="mb-3 flex items-center gap-3 rounded-xl bg-[#F4F6FA] p-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#E0A93B] text-sm font-bold text-[#0B2A4A]">{initial}</span>
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold text-[#0B2A4A]">{staff.name}</span><span className="block text-[10px] font-bold uppercase tracking-wider text-[#77869A]">{staff.role}</span></span>
                  </div>
                  <AdminNavLinks items={visibleNav} mobile />
                  <div className="mt-3 flex items-center justify-between border-t border-[#E3E8EF] pt-3">
                    <a href="/" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-[#0B2A4A]">Open website ↗</a>
                    <form action={logoutAction}><button className="rounded-lg px-2 py-1 text-xs font-semibold text-[#8A3340] outline-none focus-visible:ring-2 focus-visible:ring-[#E0A93B]">Sign out</button></form>
                  </div>
                </div>
              </details>

              <div className="hidden items-center gap-2 border-l border-[#E0E6ED] pl-3 lg:flex">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#0B2A4A] text-xs font-bold text-[#FFFFFF]">{initial}</span>
                <span className="hidden xl:block"><span className="block max-w-36 truncate text-xs font-semibold text-[#0B2A4A]">{staff.name}</span><span className="block text-[9px] font-bold uppercase tracking-wider text-[#8390A0]">{staff.role}</span></span>
              </div>
            </div>
          </header>

          <main className="min-h-[calc(100vh-4.5rem)] p-4 md:p-7 lg:p-9 xl:p-10">
            <div className="mx-auto w-full max-w-[96rem]">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/admin"
      aria-label="Personal Touch admin dashboard"
      className={`group flex items-center outline-none focus-visible:ring-2 focus-visible:ring-[#E0A93B] ${
        compact
          ? "gap-2.5 rounded-lg text-[#0B2A4A]"
          : "-mx-4 -mt-5 justify-center border-b border-[#D8D1C4] bg-[#F6F2EA] px-4 py-4"
      }`}
    >
      <Image
        src="/brand/personal-touch-logo.png"
        alt=""
        width={948}
        height={1074}
        sizes={compact ? "40px" : "96px"}
        className={compact ? "h-10 w-auto" : "h-24 w-auto"}
        priority
      />
      {compact && (
        <span className="leading-none">
          <span className="block text-sm font-bold tracking-[-0.02em]">Personal Touch</span>
          <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.2em] text-[#697A8F]">Operations</span>
        </span>
      )}
    </Link>
  );
}
