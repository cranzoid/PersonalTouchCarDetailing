"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addSuppressionAction, removeSuppressionAction } from "../actions";
import { card, heading, input, label, primaryButton, secondaryButton, subtle } from "../ui";

type Entry = {
  id: string;
  channel: "email" | "sms";
  destination: string;
  rawDestination: string;
  reason: string;
  note: string | null;
  addedAt: string;
};

export function SuppressionManager({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [destination, setDestination] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const result = await addSuppressionAction({ channel, destination, note: note || undefined });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setDestination("");
    setNote("");
    router.refresh();
  }

  async function lift(entry: Entry) {
    setBusy(true);
    setError(null);
    const result = await removeSuppressionAction({ channel: entry.channel, destination: entry.rawDestination });
    setBusy(false);
    setConfirming(null);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <section className={card}>
        <h2 className={heading}>Add someone</h2>
        <p className={`mt-1 ${subtle}`}>
          For someone who asks to be taken off in person or over the phone. STOP replies and
          unsubscribe clicks are added on their own.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <label className={label}>
            Channel
            <select
              value={channel}
              onChange={(event) => setChannel(event.target.value as "sms" | "email")}
              className={input}
            >
              <option value="sms">Phone</option>
              <option value="email">Email</option>
            </select>
          </label>
          <label className={label}>
            {channel === "sms" ? "Phone number" : "Email address"}
            <input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={channel === "sms" ? "905 555 1234" : "someone@example.com"}
              className={input}
            />
          </label>
        </div>
        <label className={`mt-4 block ${label}`}>
          Note (optional)
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            placeholder="Asked at the counter on Tuesday"
            className={input}
          />
        </label>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={busy || destination.trim().length < 3} onClick={add} className={primaryButton}>
            {busy ? "Adding…" : "Add to list"}
          </button>
          {error && <span className="text-sm text-[#8B3F3F]">{error}</span>}
        </div>
      </section>

      {entries.length > 0 && (
        <section className={card}>
          <h2 className={heading}>On the list</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Contact</th>
                  <th className="py-2 pr-3 font-semibold">Channel</th>
                  <th className="py-2 pr-3 font-semibold">Reason</th>
                  <th className="py-2 pr-3 font-semibold">Added</th>
                  <th className="py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EBF0F5]">
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-3 pr-3">
                      <span className="block font-medium text-[#25313F]">{entry.destination}</span>
                      {entry.note && <span className="block text-xs text-[#8494A5]">{entry.note}</span>}
                    </td>
                    <td className="py-3 pr-3 uppercase text-[#526A80]">{entry.channel}</td>
                    <td className="py-3 pr-3 text-[#526A80]">{entry.reason}</td>
                    <td className="py-3 pr-3 text-[#78889A]">{entry.addedAt}</td>
                    <td className="py-3 text-right">
                      {confirming === entry.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-[#8B3F3F]">They asked to be put back?</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => lift(entry)}
                            className="rounded-lg bg-[#8B3F3F] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                          >
                            Yes, remove
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="text-xs font-semibold text-[#526A80]"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirming(entry.id)}
                          className={`${secondaryButton} min-h-9 px-3 text-xs`}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
