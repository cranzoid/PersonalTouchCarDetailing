"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadJobPhotosAction } from "../actions";

const KINDS = ["before", "progress", "after", "damage", "other"] as const;

export function PhotoUpload({ jobId }: { jobId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("before");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) {
      setError("Choose at least one photo");
      return;
    }
    const formData = new FormData();
    formData.set("jobId", jobId);
    formData.set("kind", kind);
    for (const file of Array.from(files)) formData.append("photos", file);
    setBusy(true);
    setError(null);
    const res = await uploadJobPhotosAction(formData);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
        className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm capitalize text-ink-200"
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        multiple
        className="text-sm text-ink-400 file:mr-2 file:rounded-lg file:border-0 file:bg-ink-800 file:px-3 file:py-2 file:text-sm file:text-ink-200"
      />
      <button
        disabled={busy}
        onClick={() => void upload()}
        className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-40"
      >
        {busy ? "Uploading…" : "Upload"}
      </button>
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
