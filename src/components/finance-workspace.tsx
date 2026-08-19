import Link from "next/link";
import type { ReactNode } from "react";

export type FinancePage = "reports" | "expenses" | "hours" | "payroll";

const FINANCE_PAGES: { key: FinancePage; href: string; label: string; description: string }[] = [
  {
    key: "reports",
    href: "/admin/reports",
    label: "Overview",
    description: "Profit, tax and performance",
  },
  {
    key: "expenses",
    href: "/admin/expenses",
    label: "Expenses",
    description: "Purchases and bills",
  },
  {
    key: "hours",
    href: "/admin/timesheets",
    label: "Hours",
    description: "Weekly time entry",
  },
  {
    key: "payroll",
    href: "/admin/reports/payroll",
    label: "Payroll",
    description: "Earnings and payouts",
  },
];

/**
 * Shared orientation for the four screens that make up the owner's financial
 * workflow. Keeping this navigation inside the page makes their relationship
 * visible without changing the established admin routes or permissions.
 */
export function FinanceWorkspaceHeader({
  active,
  title,
  description,
  eyebrow = "Business finances",
  actions,
}: {
  active: FinancePage;
  title: string;
  description: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="overflow-hidden rounded-[1.75rem] border border-[#D9E2EA] bg-white shadow-[0_12px_36px_rgba(11,42,74,0.06)]">
      <div className="relative overflow-hidden px-5 py-6 sm:px-7 sm:py-7">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 w-2/5 bg-[radial-gradient(circle_at_top_right,rgba(224,169,59,0.16),transparent_68%)]"
        />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">
              {eyebrow}
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.025em] text-[#0B2A4A] sm:text-[2rem]">
              {title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5D7084]">{description}</p>
          </div>
          {actions && <div className="relative flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>

      <nav
        aria-label="Financial workspace"
        className="flex overflow-x-auto border-t border-[#E2E8EF] bg-[#F8FAFC] px-2 sm:px-4"
      >
        {FINANCE_PAGES.map((page) => {
          const selected = page.key === active;
          return (
            <Link
              key={page.key}
              href={page.href}
              aria-current={selected ? "page" : undefined}
              className={`relative min-w-max px-3.5 py-3.5 outline-none transition sm:px-4 ${
                selected
                  ? "text-[#0B2A4A]"
                  : "text-[#66788A] hover:bg-white/70 hover:text-[#0B2A4A]"
              }`}
            >
              <span className="block text-sm font-semibold">{page.label}</span>
              <span className="mt-0.5 hidden text-[10px] text-[#7A8A9A] md:block">
                {page.description}
              </span>
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[#E0A93B]"
                />
              )}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

export function FinanceMetric({
  label,
  value,
  detail,
  tone = "default",
  featured = false,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: "default" | "positive" | "warning" | "danger" | "accent";
  featured?: boolean;
}) {
  const toneClass = {
    default: "bg-[#0B2A4A]",
    positive: "bg-[#16805C]",
    warning: "bg-[#C48616]",
    danger: "bg-[#B94A57]",
    accent: "bg-[#E0A93B]",
  }[tone];

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-[#DCE4EC] bg-white shadow-[0_8px_24px_rgba(11,42,74,0.045)] ${
        featured ? "p-6 sm:p-7" : "p-5"
      }`}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${toneClass}`} />
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#718296]">{label}</p>
      <div
        className={`mt-2 font-bold tracking-[-0.025em] text-[#0B2A4A] ${
          featured ? "text-4xl sm:text-[2.75rem]" : "text-2xl sm:text-[1.75rem]"
        }`}
      >
        {value}
      </div>
      <div className="mt-2 text-xs leading-5 text-[#697B8D]">{detail}</div>
    </div>
  );
}

export function FinanceSection({
  id,
  title,
  description,
  action,
  children,
  className = "",
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-heading` : undefined}
      className={`overflow-hidden rounded-2xl border border-[#DCE4EC] bg-white shadow-[0_8px_24px_rgba(11,42,74,0.04)] ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E5EAF0] px-5 py-4 sm:px-6">
        <div className="max-w-3xl">
          <h2
            id={id ? `${id}-heading` : undefined}
            className="text-base font-bold tracking-[-0.015em] text-[#0B2A4A]"
          >
            {title}
          </h2>
          {description && <div className="mt-1 text-xs leading-5 text-[#697B8D]">{description}</div>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

export const financeButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-[#D4DEE7] bg-white px-3.5 py-2 text-xs font-semibold text-[#344E65] shadow-sm outline-none transition hover:border-[#9FB0C0] hover:text-[#0B2A4A] focus-visible:ring-2 focus-visible:ring-[#E0A93B]";

export const financePrimaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl bg-[#0B2A4A] px-4 py-2 text-sm font-semibold text-[#FFFFFF] shadow-sm outline-none transition hover:bg-[#123B63] focus-visible:ring-2 focus-visible:ring-[#E0A93B] disabled:cursor-not-allowed disabled:opacity-45";

export const financeInput =
  "w-full min-h-11 rounded-xl border border-[#C9D5E0] bg-white px-3 py-2.5 text-sm text-[#17344F] shadow-sm outline-none placeholder:text-[#93A2B1] focus:border-[#0B2A4A] focus:ring-2 focus:ring-[#E0A93B]/35";

export const financeLabel = "block text-xs font-semibold text-[#526A80]";
