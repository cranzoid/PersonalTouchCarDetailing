"use client";

import Image from "next/image";
import { useActionState } from "react";
import { loginAction } from "./actions";

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <main className="min-h-screen bg-[#F4F6FA] text-[#1C2026]">
      <div className="grid min-h-screen lg:grid-cols-[minmax(24rem,0.92fr)_minmax(32rem,1.08fr)]">
        <section className="relative hidden overflow-hidden bg-[#F6F2EA] p-12 text-[#0B2A4A] lg:flex lg:flex-col lg:justify-between xl:p-16" aria-label="Personal Touch staff portal">
          <div className="absolute -left-32 top-24 h-80 w-80 rounded-full border border-[#0B2A4A]/10" aria-hidden="true" />
          <div className="absolute -left-16 top-40 h-80 w-80 rounded-full border border-[#0B2A4A]/[0.07]" aria-hidden="true" />
          <div className="absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-[#E0A93B]/14 blur-3xl" aria-hidden="true" />

          <div className="relative inline-flex w-fit items-center justify-center">
            <Image
              src="/brand/personal-touch-logo.png"
              alt="Personal Touch Car Detailing"
              width={948}
              height={1074}
              sizes="144px"
              className="h-36 w-auto"
              priority
            />
          </div>

          <div className="relative max-w-xl py-16">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#C58D24]/35 bg-[#E0A93B]/12 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[#805D16]"><span className="h-1.5 w-1.5 rounded-full bg-[#E0A93B]" /> Staff operations</span>
            <h1 className="mt-7 max-w-lg text-4xl font-bold leading-[1.08] tracking-[-0.04em] xl:text-5xl">Every customer detail, in one polished workspace.</h1>
            <p className="mt-5 max-w-md text-base leading-7 text-[#536477]">Manage appointments, estimates, vehicles, jobs and billing from the secure Personal Touch operations console.</p>
            <div className="mt-10 flex flex-wrap gap-2 text-[11px] font-semibold text-[#536477]">
              {['CRM', 'Scheduling', 'Job control', 'Invoicing'].map((label) => <span key={label} className="rounded-full border border-[#0B2A4A]/10 bg-white/45 px-3 py-1.5">{label}</span>)}
            </div>
          </div>

          <p className="relative text-xs text-[#0B2A4A]/45">Authorized team members only · Personal Touch Car Detailing</p>
        </section>

        <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-10 lg:px-16">
          <div className="w-full max-w-md">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <Image
                src="/brand/personal-touch-logo.png"
                alt="Personal Touch Car Detailing"
                width={948}
                height={1074}
                sizes="64px"
                className="h-16 w-auto"
                priority
              />
              <span><span className="block text-sm font-bold text-[#0B2A4A]">Staff operations</span><span className="mt-1 block text-[9px] font-bold uppercase tracking-[0.2em] text-[#77869A]">Secure workspace</span></span>
            </div>

            <div className="mb-8">
              <span className="grid h-12 w-12 place-items-center rounded-2xl border border-[#DCE3EB] bg-white text-[#0B2A4A] shadow-sm">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1"/></svg>
              </span>
              <p className="mt-6 text-[10px] font-bold uppercase tracking-[0.22em] text-[#9A792C]">Secure staff access</p>
              <h2 className="mt-2 text-3xl font-bold tracking-[-0.035em] text-[#0B2A4A]">Welcome back</h2>
              <p className="mt-2 text-sm leading-6 text-[#66758A]">Sign in with your staff account to open the operations workspace.</p>
            </div>

            <form action={formAction} className="rounded-2xl border border-[#DDE4EC] bg-white p-6 shadow-[0_24px_70px_rgba(11,42,74,0.08)] sm:p-8">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-[#34465C]">Work email</span>
                <input
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="you@personaltouch.ca"
                  className="h-12 w-full rounded-lg border border-[#CDD6E1] bg-[#F9FAFC] px-4 text-sm text-[#1C2026] outline-none transition placeholder:text-[#A0ABBA] focus:border-[#0B2A4A] focus:bg-white focus:ring-4 focus:ring-[#0B2A4A]/8"
                />
              </label>
              <label className="mt-5 block">
                <span className="mb-2 block text-xs font-bold text-[#34465C]">Password</span>
                <input
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="h-12 w-full rounded-lg border border-[#CDD6E1] bg-[#F9FAFC] px-4 text-sm text-[#1C2026] outline-none transition placeholder:text-[#A0ABBA] focus:border-[#0B2A4A] focus:bg-white focus:ring-4 focus:ring-[#0B2A4A]/8"
                />
              </label>

              {state && !state.ok && (
                <p role="alert" aria-live="polite" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm font-medium text-red-700">{state.error}</p>
              )}

              <button
                type="submit"
                disabled={pending}
                className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#0B2A4A] px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(11,42,74,0.18)] outline-none transition hover:bg-[#123B64] focus-visible:ring-4 focus-visible:ring-[#E0A93B]/35 disabled:cursor-wait disabled:opacity-60"
              >
                {pending ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" /> Signing in…</> : <>Sign in to dashboard <span aria-hidden="true">→</span></>}
              </button>
            </form>

            <p className="mt-6 text-center text-xs leading-5 text-[#7B8899]">Having trouble signing in? Contact the account owner to reset your staff access.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
