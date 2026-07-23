import Link from "next/link";
import type { ReactNode } from "react";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-10 ${className}`}>{children}</div>;
}

const buttonStyles = {
  primary:
    "border border-accent-400 bg-accent-400 text-ink-950 hover:border-accent-300 hover:bg-accent-300 font-semibold shadow-[0_10px_28px_rgba(224,169,59,0.14)]",
  outline:
    "border border-ink-500/70 text-ink-100 hover:border-accent-400 hover:bg-white/5 hover:text-accent-300",
  ghost: "border border-transparent text-ink-300 hover:text-white",
} as const;

export function ButtonLink({
  href,
  variant = "primary",
  children,
  className = "",
}: {
  href: string;
  variant?: keyof typeof buttonStyles;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 items-center justify-center rounded-xl px-6 py-3 text-sm tracking-[0.01em] transition-all duration-200 ${buttonStyles[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone = "dark",
  align = "left",
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  tone?: "dark" | "light";
  align?: "left" | "center";
}) {
  const centered = align === "center";
  return (
    <div className={`mb-12 max-w-3xl ${centered ? "mx-auto text-center" : ""}`}>
      {eyebrow && (
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-accent-500">
          {eyebrow}
        </p>
      )}
      <h2
        className={`font-display text-4xl leading-[1.05] tracking-[-0.025em] sm:text-5xl ${
          tone === "light" ? "text-[#1C2026]" : "text-white"
        }`}
      >
        {title}
      </h2>
      {subtitle && (
        <p className={`mt-5 max-w-2xl text-base leading-7 ${centered ? "mx-auto" : ""} ${tone === "light" ? "text-slate-600" : "text-ink-300"}`}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

export function Card({
  children,
  className = "",
  tone = "dark",
}: {
  children: ReactNode;
  className?: string;
  tone?: "dark" | "light";
}) {
  return (
    <div
      className={`rounded-[1.25rem] border p-6 ${
        tone === "light"
          ? "border-[#DED8CE] bg-[#FFFEFB] text-[#1C2026] shadow-[0_16px_45px_rgba(11,42,74,0.07)]"
          : "border-white/10 bg-white/[0.045] text-ink-100 backdrop-blur"
      } ${className}`}
    >
      {children}
    </div>
  );
}
