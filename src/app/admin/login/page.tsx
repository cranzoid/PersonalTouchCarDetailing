"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={formAction} className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900/60 p-8">
        <h1 className="text-xl font-bold text-white">
          Personal <span className="text-accent-400">Touch</span> — Staff
        </h1>
        <p className="mt-1 text-sm text-ink-400">Sign in to the admin console.</p>
        <label className="mt-6 block">
          <span className="mb-1 block text-sm text-ink-300">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            className="w-full rounded-lg border border-ink-600 bg-ink-950 px-4 py-2 text-white"
          />
        </label>
        <label className="mt-4 block">
          <span className="mb-1 block text-sm text-ink-300">Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg border border-ink-600 bg-ink-950 px-4 py-2 text-white"
          />
        </label>
        {state && !state.ok && <p className="mt-3 text-sm text-red-400">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="mt-6 w-full rounded-lg bg-accent-400 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
        >
          {pending ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
