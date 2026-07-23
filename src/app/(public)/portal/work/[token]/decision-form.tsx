"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { decideAdditionalWorkAction } from "./actions";

export function DecisionForm({ token }: { token: string }) {
  const nameId = useId();
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "decline") {
    if (!name.trim()) {
      setError("Please type your full name — it acts as your signature.");
      return;
    }
    if (decision === "decline" && !window.confirm("Decline this additional work?")) return;
    setBusy(true);
    setError(null);
    const res = await decideAdditionalWorkAction({ token, decision, name: name.trim() });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="mt-6 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-5 shadow-xl shadow-black/15 sm:p-6">
      <label htmlFor={nameId} className="text-sm font-medium text-ink-200">
        Your full name (acts as your signature)
      </label>
      <input
        id={nameId}
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Jane Smith"
        className="mt-2 min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/70 px-4 py-3 text-base text-white placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
      />
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("approve")}
          className="min-h-11 flex-1 rounded-xl bg-accent-400 px-4 py-3 text-base font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Sending…" : "Approve this work"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("decline")}
          className="min-h-11 flex-1 rounded-xl border border-ink-600 px-4 py-3 text-base font-medium text-ink-200 hover:border-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          No thanks
        </button>
      </div>
      {error && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
