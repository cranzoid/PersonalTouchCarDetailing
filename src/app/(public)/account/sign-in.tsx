"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "./actions";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400";
const input = `min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950 px-4 py-2.5 text-base text-white placeholder:text-ink-500 ${focusRing}`;

/**
 * Two steps: where to send a code, then the code. No password ever exists, so
 * there is nothing to forget, reuse or leak.
 */
export function SignIn({ intro }: { intro?: string }) {
  const router = useRouter();
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [contact, setContact] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestCodeAction({ channel, contact });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSentTo(contact);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await verifyCodeAction({ channel, contact, code });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <h2 className="text-2xl font-bold text-white">Sign in</h2>
      <p className="mt-2 text-sm leading-6 text-ink-300">
        {intro ?? "Use the email address or mobile number you gave us. We'll send you a 6-digit code — no password needed."}
      </p>
      {!sentTo ? (
        <form onSubmit={send} className="mt-6 space-y-4">
          <div role="radiogroup" aria-label="Send my code by" className="grid grid-cols-2 gap-2">
            {(["email", "sms"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={channel === option}
                onClick={() => {
                  setChannel(option);
                  setContact("");
                }}
                className={`min-h-11 rounded-xl border px-3 text-sm font-medium ${focusRing} ${
                  channel === option ? "border-accent-400 bg-accent-400 text-ink-950" : "border-ink-600 text-ink-200 hover:bg-ink-800"
                }`}
              >
                {option === "email" ? "Email" : "Text message"}
              </button>
            ))}
          </div>
          <label className="block text-sm text-ink-300">
            {channel === "email" ? "Email address" : "Mobile number"}
            <input
              className={`${input} mt-1`}
              type={channel === "email" ? "email" : "tel"}
              autoComplete={channel === "email" ? "email" : "tel"}
              inputMode={channel === "email" ? "email" : "tel"}
              required
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={channel === "email" ? "you@example.com" : "905-555-0123"}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className={`min-h-11 w-full rounded-xl bg-accent-400 px-4 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40 ${focusRing}`}
          >
            {busy ? "Sending…" : "Send my code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-6 space-y-4">
          <p className="text-sm text-ink-300">
            We sent a code to <strong className="text-white">{sentTo}</strong>. It expires in 10 minutes.
          </p>
          <label className="block text-sm text-ink-300">
            6-digit code
            <input
              className={`${input} mt-1 text-center text-2xl tracking-[0.4em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className={`min-h-11 w-full rounded-xl bg-accent-400 px-4 py-3 font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40 ${focusRing}`}
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setCode("");
              setError(null);
            }}
            className={`w-full text-sm text-accent-300 underline-offset-4 hover:underline ${focusRing}`}
          >
            Use a different email or number
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
