"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { QC_CHECKLIST_ITEMS } from "@/lib/types";
import { saveQcChecklistAction } from "../actions";

export function QcChecklistForm({
  jobId,
  items,
  notes,
  completedAt,
}: {
  jobId: string;
  items: Record<string, boolean>;
  notes: string;
  completedAt: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, boolean>>(items);
  const [noteText, setNoteText] = useState(notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkedCount = QC_CHECKLIST_ITEMS.filter((i) => state[i.key]).length;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await saveQcChecklistAction({ jobId, items: state, notes: noteText });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-800 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
          QC checklist
        </h2>
        <span className={`text-xs ${completedAt ? "text-emerald-300" : "text-ink-500"}`}>
          {completedAt
            ? `Passed ${new Date(completedAt).toLocaleDateString("en-CA")}`
            : `${checkedCount}/${QC_CHECKLIST_ITEMS.length}`}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {QC_CHECKLIST_ITEMS.map((item) => (
          <label key={item.key} className="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
            <input
              type="checkbox"
              checked={state[item.key] ?? false}
              onChange={(e) => setState((s) => ({ ...s, [item.key]: e.target.checked }))}
              className="h-4 w-4 accent-emerald-400"
            />
            {item.label}
          </label>
        ))}
      </div>
      <textarea
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        placeholder="QC notes (optional)"
        rows={2}
        className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save checklist"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </section>
  );
}
