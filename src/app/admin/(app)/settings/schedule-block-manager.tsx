"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createScheduleBlockAction, removeScheduleBlockAction } from "./actions";

type Target = { id: string; name: string };
type BlockSummary = {
  id: string;
  type: string;
  targetName: string;
  startsLabel: string;
  endsLabel: string;
  reason: string;
};

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

export function ScheduleBlockManager({ staff, bays, blocks }: { staff: Target[]; bays: Target[]; blocks: BlockSummary[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ type: "closure", targetId: "", startsLocal: "", endsLocal: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const targets = form.type === "bay" ? bays : form.type === "staff" ? staff : [];

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await createScheduleBlockAction(form);
    setBusy(false);
    if (!result.ok) return setMessage({ ok: false, text: result.error });
    setForm({ type: "closure", targetId: "", startsLocal: "", endsLocal: "", reason: "" });
    setMessage({ ok: true, text: "Schedule block created." });
    router.refresh();
  }

  async function remove(blockId: string) {
    if (!window.confirm("Remove this schedule block? New bookings may become available during this time.")) return;
    setBusy(true);
    setMessage(null);
    const result = await removeScheduleBlockAction({ blockId });
    setBusy(false);
    if (!result.ok) setMessage({ ok: false, text: result.error });
    else {
      setMessage({ ok: true, text: "Schedule block removed." });
      router.refresh();
    }
  }

  return (
    <section className="mt-12 border-t border-ink-800 pt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Schedule blocks</h2>
      <p className="mt-2 text-xs leading-5 text-ink-500">Block the whole business, one bay, or one staff member. Times are interpreted in the configured business timezone. Blocks that conflict with an existing appointment are rejected.</p>
      <form onSubmit={create} className="mt-5 grid gap-3 rounded-xl border border-ink-800 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-ink-400">Block type
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value, targetId: "" })} className={`${inputClass} mt-1`}>
            <option value="closure">Whole-business closure</option>
            <option value="bay">Bay maintenance</option>
            <option value="staff">Staff time off</option>
          </select>
        </label>
        {form.type !== "closure" && <label className="text-xs text-ink-400">{form.type === "bay" ? "Bay" : "Staff member"}
          <select required value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })} className={`${inputClass} mt-1`}>
            <option value="">Select…</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
        </label>}
        <label className="text-xs text-ink-400">Starts
          <input required type="datetime-local" value={form.startsLocal} onChange={(event) => setForm({ ...form, startsLocal: event.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs text-ink-400">Ends
          <input required type="datetime-local" value={form.endsLocal} onChange={(event) => setForm({ ...form, endsLocal: event.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs text-ink-400 sm:col-span-2">Reason
          <input required maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Holiday closure, lift maintenance, vacation…" className={`${inputClass} mt-1`} />
        </label>
        <button disabled={busy} className="self-end rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40">{busy ? "Saving…" : "Add block"}</button>
      </form>
      {message && <p className={`mt-3 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}

      <div className="mt-6 space-y-2">
        {blocks.map((block) => <article key={block.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-800 p-4 text-sm">
          <div><p className="font-medium capitalize text-white">{block.type} · {block.targetName}</p><p className="mt-1 text-xs text-ink-400">{block.startsLabel} → {block.endsLabel}</p><p className="mt-1 text-xs text-ink-500">{block.reason}</p></div>
          <button type="button" onClick={() => void remove(block.id)} disabled={busy} className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40">Remove</button>
        </article>)}
        {blocks.length === 0 && <p className="text-sm text-ink-500">No upcoming schedule blocks.</p>}
      </div>
    </section>
  );
}
