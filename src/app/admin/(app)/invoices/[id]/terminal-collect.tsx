"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import {
  pollTerminalCollectionAction,
  startTerminalCollectionAction,
  stopTerminalCollectionAction,
} from "../actions";

/**
 * "Collect on terminal": pushes the balance to the Smart Terminal and waits
 * while the customer taps, inserts or swipes. The payment records itself — no
 * typing the amount into the terminal and then again into this page.
 */
export function TerminalCollect({
  invoiceId,
  balanceCents,
  currency,
  disabled,
}: {
  invoiceId: string;
  balanceCents: number;
  currency: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "waiting" | "paid" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state !== "waiting" || !checkoutId) return;
    let cancelled = false;
    const startedAt = Date.now();
    async function poll() {
      if (cancelled || !checkoutId) return;
      const status = await pollTerminalCollectionAction({ checkoutId }).catch(() => null);
      if (cancelled) return;
      if (status?.ok && status.state === "paid") {
        setState("paid");
        setMessage(
          `Paid ${formatCents(status.amountCents, currency)} on the terminal${
            status.tipCents ? `, including a ${formatCents(status.tipCents, currency)} tip` : ""
          }.`,
        );
        router.refresh();
        return;
      }
      if (status?.ok && status.state === "failed") {
        setState("failed");
        setMessage(status.reason);
        return;
      }
      if (Date.now() - startedAt > 10 * 60_000) {
        setState("failed");
        setMessage("No answer from the terminal. If the customer did pay, it will appear here within the hour.");
        return;
      }
      timer.current = setTimeout(() => void poll(), 3_000);
    }
    timer.current = setTimeout(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, checkoutId, currency, router]);

  async function send() {
    setState("sending");
    setMessage(null);
    const result = await startTerminalCollectionAction({ invoiceId });
    if (!result.ok) {
      setState("failed");
      setMessage(result.error);
      return;
    }
    setCheckoutId(result.checkoutId);
    setState("waiting");
  }

  async function stop() {
    if (!checkoutId) return;
    const result = await stopTerminalCollectionAction({ checkoutId });
    if (!result.ok) {
      setMessage(result.error);
      router.refresh();
      return;
    }
    setState("idle");
    setCheckoutId(null);
  }

  return (
    <div className="border-t border-ink-800 pt-5">
      <p className="text-sm font-medium text-white">Card on the Smart Terminal</p>
      <p className="mt-1 text-xs text-ink-500">
        Sends {formatCents(balanceCents, currency)} to the terminal. The customer taps, inserts or swipes, and the
        payment records itself. A tip added on the terminal is recorded as the invoice&apos;s tip.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {state === "waiting" ? (
          <>
            <span role="status" className="inline-flex items-center gap-2 text-sm text-accent-200">
              <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent-300" />
              Waiting for the customer to pay on the terminal…
            </span>
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-800"
            >
              Stop waiting
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={disabled || state === "sending" || state === "paid"}
            className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {state === "sending" ? "Sending to terminal…" : state === "failed" ? "Try the terminal again" : `Collect ${formatCents(balanceCents, currency)} on terminal`}
          </button>
        )}
      </div>
      {message && (
        <p
          role={state === "failed" ? "alert" : "status"}
          className={`mt-2 text-xs ${state === "paid" ? "text-emerald-300" : state === "failed" ? "text-red-300" : "text-ink-400"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
