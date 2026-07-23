"use client";

import { useState } from "react";
import { createAppointmentDepositCheckoutAction } from "./actions";

export function DepositPayButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    const result = await createAppointmentDepositCheckoutAction({ token });
    if (result.ok) {
      window.location.href = result.url;
      return;
    }
    setBusy(false);
    setError(result.error);
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void pay()}
        className="min-h-11 w-full rounded-xl bg-accent-400 px-5 py-3 font-semibold text-ink-950 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Opening secure checkout…" : "Pay Deposit Securely"}
      </button>
      {error && <p role="alert" aria-live="assertive" className="mt-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
