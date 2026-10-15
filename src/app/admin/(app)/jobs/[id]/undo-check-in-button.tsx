"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { undoCheckInAction } from "../actions";

/**
 * For a vehicle checked in by mistake: deletes the job and puts the
 * appointment back to how it was, then opens the appointment so staff can
 * cancel it, mark a no-show or check it in again properly.
 */
export function UndoCheckInButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (
      !window.confirm(
        "Undo this check-in? The job is deleted and the appointment goes back to how it was before check-in. Any inspection and QC checklist on it are removed; photos stay on the vehicle.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await undoCheckInAction({ jobId });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.push(`/admin/appointments/${res.appointmentId}`);
  }

  return (
    <div className="mt-2">
      <button
        disabled={busy}
        onClick={() => void run()}
        className="rounded-lg border border-red-900 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950/40 disabled:opacity-40"
      >
        {busy ? "Undoing…" : "Undo check-in"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
