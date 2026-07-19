import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getStaff } from "@/lib/auth/session";
import { logoutAction } from "../login/actions";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/appointments", label: "Appointments" },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/services", label: "Services" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Layout-level gate for UX; every server action independently re-checks
  // authorization via requireStaff() — this redirect is not the security boundary.
  const staff = await getStaff();
  if (!staff) redirect("/admin/login");

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900/40 p-4 md:flex">
        <Link href="/admin" className="mb-8 block text-lg font-bold text-white">
          Personal <span className="text-accent-400">Touch</span>
          <span className="block text-xs font-normal uppercase tracking-widest text-ink-500">
            Admin
          </span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-ink-800 pt-4 text-sm">
          <p className="font-medium text-white">{staff.name}</p>
          <p className="text-xs capitalize text-ink-500">{staff.role}</p>
          <form action={logoutAction}>
            <button className="mt-2 text-xs text-ink-400 hover:text-accent-300">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="flex-1">
        {/* Mobile nav */}
        <nav className="flex gap-3 overflow-x-auto border-b border-ink-800 bg-ink-900/40 px-4 py-3 md:hidden">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="whitespace-nowrap text-sm text-ink-300">
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="p-6 lg:p-10">{children}</main>
      </div>
    </div>
  );
}
