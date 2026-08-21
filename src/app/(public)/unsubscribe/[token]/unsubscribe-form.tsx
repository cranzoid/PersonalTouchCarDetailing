"use client";

import { useState } from "react";
import { confirmUnsubscribeAction } from "./actions";

export function UnsubscribeForm({ token, maskedEmail }: { token: string; maskedEmail: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (state === "done") {
    return (
      <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-6">
        <p className="text-lg font-semibold text-white">You have been unsubscribed.</p>
        <p className="mt-2 text-sm text-ink-300">
          {maskedEmail} will not receive any more marketing email from us. Messages about work you
          book with us — confirmations, invoices and receipts — are not affected.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-6">
      <p className="text-sm text-ink-300">
        Unsubscribe <span className="font-semibold text-white">{maskedEmail}</span> from marketing
        email sent by Personal Touch Car Detailing?
      </p>
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          setError(null);
          const result = await confirmUnsubscribeAction(token);
          if (!result.ok) {
            setError(result.error);
            setState("idle");
            return;
          }
          setState("done");
        }}
        className="mt-4 rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 disabled:opacity-50"
      >
        {state === "busy" ? "Unsubscribing…" : "Yes, unsubscribe me"}
      </button>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
