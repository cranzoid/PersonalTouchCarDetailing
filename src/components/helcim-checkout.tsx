"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const HELCIM_SCRIPT_SRC = "https://secure.helcim.app/helcim-pay/services/start.js";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
    removeHelcimPayIframe?: () => void;
  }
}

export type CheckoutStartResult =
  | { ok: true; checkoutId: string; checkoutToken: string; amountCents: number }
  | { ok: false; error: string };
export type CheckoutConfirmResult =
  | { ok: true; status: "succeeded" | "pending" }
  | { ok: false; error: string };

let scriptPromise: Promise<void> | null = null;

function loadHelcimScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.appendHelcimPayIframe) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = HELCIM_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error("The secure payment form could not load"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

function isHelcimOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "helcim.app" || host.endsWith(".helcim.app") || host.endsWith(".helcim.com");
  } catch {
    return false;
  }
}

/**
 * Opens Helcim's payment form over our page. Card details are typed into
 * Helcim's own iframe and never pass through this site; what comes back to us
 * is a transaction id and a hash, which the server checks with Helcim before
 * recording anything.
 *
 * `start` and `confirm` are server actions bound to whatever is being paid —
 * this component knows nothing about invoices, deposits or memberships.
 */
export function HelcimCheckoutButton({
  label,
  busyLabel = "Opening secure checkout…",
  start,
  confirm,
  disabled = false,
  successMessage = "Payment received — thank you!",
  onSuccess,
  className,
}: {
  label: string;
  busyLabel?: string;
  start: () => Promise<CheckoutStartResult>;
  confirm: (checkoutId: string, eventMessage: string) => Promise<CheckoutConfirmResult>;
  disabled?: boolean;
  successMessage?: string;
  onSuccess?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "opening" | "open" | "confirming" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const session = useRef<{ checkoutId: string; checkoutToken: string } | null>(null);

  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const current = session.current;
      if (!current || !isHelcimOrigin(event.origin)) return;
      const data = event.data as { eventName?: string; eventStatus?: string; eventMessage?: unknown } | null;
      if (!data || data.eventName !== `helcim-pay-js-${current.checkoutToken}`) return;

      if (data.eventStatus === "SUCCESS") {
        setPhase("confirming");
        const message = typeof data.eventMessage === "string" ? data.eventMessage : JSON.stringify(data.eventMessage ?? null);
        const result = await confirm(current.checkoutId, message).catch(() => null);
        window.removeHelcimPayIframe?.();
        session.current = null;
        if (result?.ok && result.status === "succeeded") {
          setPhase("done");
          setNotice(successMessage);
          onSuccess?.();
          router.refresh();
          return;
        }
        setPhase("done");
        // The card WAS charged — Helcim said so. Never tell this customer to
        // try again; the hourly reconciliation will finish recording it.
        setNotice(
          result && !result.ok
            ? `Your payment went through, but we couldn't confirm it on this page (${result.error}). There's no need to pay again — we'll update your account shortly.`
            : "Your payment went through and is being recorded. There's no need to pay again — this page will update shortly.",
        );
        router.refresh();
        return;
      }
      if (data.eventStatus === "ABORTED") {
        // A decline. Helcim's form says so and lets the customer try another
        // card, so the session stays open.
        setError("That card was declined. You can try again with another card.");
        return;
      }
      if (data.eventStatus === "HIDE") {
        if (session.current) {
          session.current = null;
          setPhase("idle");
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [confirm, onSuccess, router, successMessage]);

  async function open() {
    setError(null);
    setNotice(null);
    setPhase("opening");
    try {
      const [result] = await Promise.all([start(), loadHelcimScript()]);
      if (!result.ok) {
        setPhase("idle");
        setError(result.error);
        return;
      }
      if (!window.appendHelcimPayIframe) throw new Error("The secure payment form could not load");
      session.current = { checkoutId: result.checkoutId, checkoutToken: result.checkoutToken };
      window.appendHelcimPayIframe(result.checkoutToken, true);
      setPhase("open");
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Online payment is unavailable right now.");
    }
  }

  const busy = phase === "opening" || phase === "confirming";
  return (
    <div className={className}>
      {phase !== "done" && (
        <button
          type="button"
          onClick={() => void open()}
          disabled={disabled || busy || phase === "open"}
          className="min-h-11 w-full rounded-xl bg-accent-400 px-4 py-3 text-base font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === "opening" ? busyLabel : phase === "confirming" ? "Confirming payment…" : phase === "open" ? "Complete payment in the secure form" : label}
        </button>
      )}
      <p className="mt-3 flex items-start justify-center gap-2 text-center text-xs leading-5 text-ink-400">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-none stroke-current" strokeWidth="1.8">
          <rect x="4" y="9" width="12" height="8" rx="1.5" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </svg>
        <span>Secure payment by Helcim. Your card details go straight to Helcim and never reach our servers.</span>
      </p>
      {notice && (
        <p role="status" className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" aria-live="assertive" className="mt-3 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
