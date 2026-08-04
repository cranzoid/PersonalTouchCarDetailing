"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_TRANSITIONS, type JobStatus } from "@/lib/types";
import { normalizeJobStatus } from "@/lib/job-status";
import { transitionJobAction } from "../actions";

/**
 * Action labels, not status names — the button says what the click does. A
 * job only ever offers its next stage plus one way back.
 */
const LABELS: Record<JobStatus, string> = {
  checked_in: "Back to checked in",
  in_progress: "Start work",
  ready_for_pickup: "Ready for pickup",
  completed: "Complete (picked up)",
};

/** Backwards moves are corrections — styled as secondary, not the main action. */
const BACKWARD: Partial<Record<JobStatus, Partial<Record<JobStatus, string>>>> = {
  in_progress: { checked_in: "Back to checked in" },
  ready_for_pickup: { in_progress: "Reopen for more work" },
};

export function JobTransitionButtons({ jobId, status }: { jobId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = normalizeJobStatus(status);
  const targets = current ? JOB_TRANSITIONS[current] : [];
  if (!current || targets.length === 0) return null;

  async function run(to: JobStatus) {
    setBusy(true);
    setError(null);
    const res = await transitionJobAction({ jobId, to });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {targets.map((to) => {
          const backLabel = BACKWARD[current]?.[to];
          return (
            <button
              key={to}
              disabled={busy}
              onClick={() => void run(to)}
              className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40 ${
                backLabel
                  ? "border border-amber-800 text-amber-300 hover:bg-amber-950/40"
                  : "bg-accent-400 text-ink-950 hover:bg-accent-300"
              }`}
            >
              {backLabel ?? LABELS[to]}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
