"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkInAppointmentAction } from "../../jobs/actions";

/** "Check In" on an arrived appointment: creates the job and opens it. */
export function CheckInButton({ appointmentId }: { appointmentId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await checkInAppointmentAction({ appointmentId });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.push(`/admin/jobs/${res.jobId}`);
  }

  return (
    <div className="mt-4">
      <button
        disabled={busy}
        onClick={() => void run()}
        className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Checking in…" : "Check In Vehicle"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
