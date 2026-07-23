"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import {
  createAdditionalWorkAction,
  sendAdditionalWorkApprovalAction,
  overrideAdditionalWorkAction,
} from "../actions";

type WorkRequest = {
  id: string;
  description: string;
  priceCents: number;
  extraMinutes: number;
  status: string;
  decidedVia: string | null;
  overrideReason: string | null;
};

export function AdditionalWorkPanel({
  jobId,
  jobStatus,
  requests,
}: {
  jobId: string;
  jobStatus: string;
  requests: WorkRequest[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [minutes, setMinutes] = useState("");
  const [lastLink, setLastLink] = useState<{ link: string; delivery: "email" | "sms" | null } | null>(null);
  const canAdd = !["completed", "ready_for_pickup"].includes(jobStatus);

  async function create() {
    const priceCents = Math.round(Number(price) * 100);
    if (!description.trim() || !Number.isFinite(priceCents) || priceCents < 0) {
      setError("Enter a description and a valid price");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createAdditionalWorkAction({
      jobId,
      description: description.trim(),
      priceCents,
      extraMinutes: minutes ? Number(minutes) : 0,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setShowForm(false);
      setDescription("");
      setPrice("");
      setMinutes("");
      router.refresh();
    }
  }

  async function sendLink(requestId: string) {
    setBusy(true);
    setError(null);
    const res = await sendAdditionalWorkApprovalAction({ requestId });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setLastLink({ link: res.link, delivery: res.delivery });
      router.refresh();
    }
  }

  async function override(requestId: string, decision: "approve" | "decline") {
    // eslint-disable-next-line no-alert
    const reason = window.prompt(
      `Reason for staff ${decision} (required — e.g. customer approved verbally in person):`,
    );
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    const res = await overrideAdditionalWorkAction({ requestId, decision, reason: reason.trim() });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-800 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
          Additional work
        </h2>
        {canAdd && (
          <button
            onClick={() => setShowForm((s) => !s)}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800"
          >
            {showForm ? "Close" : "Add request"}
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-3 space-y-2 rounded-lg border border-ink-800 bg-ink-900/40 p-4">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was found and what you propose to do (the customer sees this text)"
            rows={2}
            className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600"
          />
          <div className="flex flex-wrap gap-2">
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder="Price (CAD, before tax)"
              className="w-44 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600"
            />
            <input
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              inputMode="numeric"
              placeholder="Extra minutes"
              className="w-36 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600"
            />
            <button
              disabled={busy}
              onClick={() => void create()}
              className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {requests.length === 0 && !showForm && (
        <p className="mt-2 text-sm text-ink-500">
          Nothing yet. Found something mid-job? Add a request and send it for customer approval.
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="rounded-lg border border-ink-800 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-ink-200">{r.description}</p>
              <StatusBadge status={r.status} />
            </div>
            <p className="mt-1 text-sm text-ink-400">
              {formatCents(r.priceCents)} + tax
              {r.extraMinutes > 0 && <> · +{r.extraMinutes} min</>}
              {r.decidedVia && <> · decided via {r.decidedVia.replaceAll("_", " ")}</>}
            </p>
            {r.overrideReason && (
              <p className="mt-1 text-xs text-ink-500">Override reason: {r.overrideReason}</p>
            )}
            {r.status === "pending" && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  onClick={() => void sendLink(r.id)}
                  className="rounded-lg bg-accent-400 px-3 py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-300 disabled:opacity-40"
                >
                  Send approval link
                </button>
                <button
                  disabled={busy}
                  onClick={() => void override(r.id, "approve")}
                  className="rounded-lg border border-emerald-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40"
                >
                  Staff approve
                </button>
                <button
                  disabled={busy}
                  onClick={() => void override(r.id, "decline")}
                  className="rounded-lg border border-red-800 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-40"
                >
                  Staff decline
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {lastLink && (
        <div className="mt-3 rounded-lg bg-ink-900/60 p-3 text-xs text-ink-400">
          <p className={lastLink.delivery ? "text-emerald-300" : "text-amber-300"}>
            {lastLink.delivery
              ? `Approval link sent by ${lastLink.delivery}.`
              : "Approval link created but was not sent; copy it below."}
          </p>
          <p className="mt-1 break-all"><span className="text-accent-300">{lastLink.link}</span></p>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
