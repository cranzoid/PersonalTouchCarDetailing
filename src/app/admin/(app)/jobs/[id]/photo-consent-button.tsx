"use client";

import { useState } from "react";
import { setPhotoPublicConsentAction } from "../actions";

export function PhotoConsentButton({ fileId, consented }: { fileId: string; consented: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    const result = await setPhotoPublicConsentAction({ fileId, consent: !consented });
    setBusy(false);
    if (!result.ok) setError(result.error);
  }
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        className="text-[11px] font-medium text-accent-300 hover:underline disabled:opacity-50"
      >
        {busy ? "Saving…" : consented ? "Revoke gallery consent" : "Record gallery consent"}
      </button>
      {error && <p role="alert" className="text-[10px] text-red-300">{error}</p>}
    </div>
  );
}
