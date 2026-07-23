"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateJobNotesAction } from "../actions";

export function NotesForm({ jobId, internalNotes }: { jobId: string; internalNotes: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState(internalNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = notes !== internalNotes;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await updateJobNotesAction({ jobId, internalNotes: notes });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-800 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
        Internal notes
      </h2>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Never shown to the customer"
        rows={3}
        className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600"
      />
      {dirty && (
        <button
          disabled={busy}
          onClick={() => void save()}
          className="mt-2 rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save notes"}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
