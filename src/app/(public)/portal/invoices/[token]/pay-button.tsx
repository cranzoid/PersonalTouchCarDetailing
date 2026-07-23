"use client";

import { useState } from "react";
import { createInvoiceCheckoutAction } from "./actions";

export function PayButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    const res = await createInvoiceCheckoutAction({ token });
    if (res.ok) {
      window.location.href = res.url;
      return;
    }
    setBusy(false);
    setError(res.error);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void pay()}
        disabled={busy}
        className="min-h-11 w-full rounded-xl bg-accent-400 px-4 py-3 text-base font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Redirecting to checkout…" : "Pay Now"}
      </button>
      {error && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
