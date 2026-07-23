"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_TRANSITIONS, type JobStatus } from "@/lib/types";
import { transitionJobAction } from "../actions";

const LABELS: Record<JobStatus, string> = {
  checked_in: "Back to checked in",
  inspection: "Move to inspection",
  awaiting_approval: "Awaiting approval",
  ready: "Mark ready to start",
  in_progress: "Start work",
  paused: "Pause",
  quality_check: "Send to QC",
  correction_required: "Needs correction",
  ready_for_pickup: "Ready for pickup",
  completed: "Complete (picked up)",
};

export function JobTransitionButtons({
  jobId,
  status,
  qcComplete,
}: {
  jobId: string;
  status: string;
  qcComplete: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = JOB_TRANSITIONS[status as JobStatus] ?? [];
  if (targets.length === 0) return null;

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
          const gated = to === "ready_for_pickup" && !qcComplete;
          return (
            <button
              key={to}
              disabled={busy || gated}
              title={gated ? "Complete the QC checklist first" : undefined}
              onClick={() => void run(to)}
              className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40 ${
                to === "correction_required" || to === "paused"
                  ? "border border-amber-800 text-amber-300 hover:bg-amber-950/40"
                  : "bg-accent-400 text-ink-950 hover:bg-accent-300"
              }`}
            >
              {LABELS[to]}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
