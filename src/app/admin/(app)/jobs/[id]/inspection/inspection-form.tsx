"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { completeInspectionAction } from "../../actions";

const FINDING_TYPES = ["scratch", "dent", "chip", "stain", "pet_hair", "odour", "dirt", "other"] as const;
const SEVERITIES = ["minor", "moderate", "severe"] as const;
const AREAS = [
  "front_bumper",
  "rear_bumper",
  "hood",
  "roof",
  "trunk",
  "driver_side",
  "passenger_side",
  "wheels",
  "glass",
  "front_seats",
  "rear_seats",
  "carpet",
  "trunk_interior",
  "dashboard",
  "headliner",
  "other",
] as const;

type Finding = {
  area: string;
  type: (typeof FINDING_TYPES)[number];
  severity: (typeof SEVERITIES)[number];
  description: string;
};

/** Mobile-first: big touch targets, one column, staff fill this on a phone beside the car. */
export function InspectionForm({ jobId }: { jobId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mileage, setMileage] = useState("");
  const [concerns, setConcerns] = useState("");
  const [belongings, setBelongings] = useState("");
  const [additionalWork, setAdditionalWork] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFinding() {
    setFindings((f) => [...f, { area: "front_bumper", type: "scratch", severity: "minor", description: "" }]);
  }

  function updateFinding(i: number, patch: Partial<Finding>) {
    setFindings((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set(
      "payload",
      JSON.stringify({
        jobId,
        mileage: mileage ? Number(mileage) : undefined,
        customerConcerns: concerns || undefined,
        personalBelongings: belongings || undefined,
        additionalWorkIdentified: additionalWork || undefined,
        findings: findings.map((f) => ({ ...f, description: f.description || undefined })),
      }),
    );
    for (const file of Array.from(fileRef.current?.files ?? [])) formData.append("photos", file);
    const res = await completeInspectionAction(formData);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.push(`/admin/jobs/${jobId}`);
  }

  const inputCls =
    "w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-3 text-base text-ink-200 placeholder:text-ink-600";
  const selectCls =
    "rounded-lg border border-ink-700 bg-ink-900 px-2 py-2.5 text-sm capitalize text-ink-200";

  return (
    <div className="mt-6 space-y-5 pb-24">
      <div>
        <label className="text-sm font-medium text-ink-300">Mileage (km)</label>
        <input value={mileage} onChange={(e) => setMileage(e.target.value)} inputMode="numeric" placeholder="e.g. 84500" className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className="text-sm font-medium text-ink-300">Customer concerns</label>
        <textarea value={concerns} onChange={(e) => setConcerns(e.target.value)} rows={2} placeholder="What the customer asked us to pay attention to" className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className="text-sm font-medium text-ink-300">Personal belongings</label>
        <textarea value={belongings} onChange={(e) => setBelongings(e.target.value)} rows={2} placeholder="Items left in the vehicle (noted for return at pickup)" className={`mt-1 ${inputCls}`} />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-ink-300">Condition findings</label>
          <button onClick={addFinding} className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800">
            + Add finding
          </button>
        </div>
        {findings.length === 0 && (
          <p className="mt-2 text-sm text-ink-500">
            Record existing damage, stains, pet hair or odours — this protects you and the customer.
          </p>
        )}
        <div className="mt-2 space-y-3">
          {findings.map((f, i) => (
            <div key={i} className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
              <div className="flex flex-wrap gap-2">
                <select value={f.area} onChange={(e) => updateFinding(i, { area: e.target.value })} className={selectCls}>
                  {AREAS.map((a) => (
                    <option key={a} value={a}>{a.replaceAll("_", " ")}</option>
                  ))}
                </select>
                <select value={f.type} onChange={(e) => updateFinding(i, { type: e.target.value as Finding["type"] })} className={selectCls}>
                  {FINDING_TYPES.map((t) => (
                    <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                  ))}
                </select>
                <select value={f.severity} onChange={(e) => updateFinding(i, { severity: e.target.value as Finding["severity"] })} className={selectCls}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button
                  onClick={() => setFindings((all) => all.filter((_, idx) => idx !== i))}
                  className="ml-auto text-sm text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
              <input
                value={f.description}
                onChange={(e) => updateFinding(i, { description: e.target.value })}
                placeholder="Optional note (e.g. 10cm scratch above wheel arch)"
                className={`mt-2 ${inputCls}`}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-ink-300">Additional work identified</label>
        <textarea value={additionalWork} onChange={(e) => setAdditionalWork(e.target.value)} rows={2} placeholder="Anything worth proposing to the customer (create the priced request on the job page)" className={`mt-1 ${inputCls}`} />
      </div>

      <div>
        <label className="text-sm font-medium text-ink-300">Photos</label>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          capture="environment"
          multiple
          className="mt-1 w-full text-sm text-ink-400 file:mr-2 file:rounded-lg file:border-0 file:bg-ink-800 file:px-3 file:py-2.5 file:text-sm file:text-ink-200"
        />
        <p className="mt-1 text-xs text-ink-500">Walk-around photos; stored privately, staff-only.</p>
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-ink-800 bg-ink-950/95 p-4 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <button
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-accent-400 px-4 py-3 text-base font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Complete inspection"}
          </button>
        </div>
        {error && <p className="mx-auto mt-2 max-w-xl text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
