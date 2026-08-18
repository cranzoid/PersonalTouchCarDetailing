"use client";

import { useRouter } from "next/navigation";

export type PeriodKind = "month" | "quarter" | "year";
export type PeriodInfo = { kind: PeriodKind; year: number; index: number; label: string };

/**
 * Calendar period stepper shared by Expenses and Reports, so both screens move
 * through months, quarters and years the same way and a link between them keeps
 * the period the owner was looking at.
 */
export function PeriodNav({
  period,
  basePath,
  extraParams,
}: {
  period: PeriodInfo;
  basePath: string;
  extraParams?: Record<string, string>;
}) {
  const router = useRouter();

  function go(next: Partial<PeriodInfo>) {
    const merged = { ...period, ...next };
    const params = new URLSearchParams({
      ...extraParams,
      kind: merged.kind,
      y: String(merged.year),
      i: String(merged.index),
    });
    router.push(`${basePath}?${params.toString()}`);
  }

  /** Step one period, rolling the year over at the edges. */
  function step(direction: -1 | 1) {
    if (period.kind === "year") return go({ year: period.year + direction });
    const max = period.kind === "month" ? 12 : 4;
    const next = period.index + direction;
    if (next < 1) return go({ year: period.year - 1, index: max });
    if (next > max) return go({ year: period.year + 1, index: 1 });
    go({ index: next });
  }

  /** Changing unit stays in the same part of the year rather than jumping to January. */
  function switchKind(kind: PeriodKind) {
    if (kind === period.kind) return;
    if (kind === "year") return go({ kind, index: 1 });
    if (kind === "quarter") {
      return go({ kind, index: period.kind === "month" ? Math.ceil(period.index / 3) : 1 });
    }
    go({ kind, index: period.kind === "quarter" ? (period.index - 1) * 3 + 1 : 1 });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 rounded-xl border border-ink-700 bg-ink-900/50 p-1">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous period"
          className="rounded-lg px-3 py-2 text-ink-300 hover:bg-ink-800 hover:text-white"
        >
          ←
        </button>
        <span className="min-w-40 px-2 text-center text-sm font-semibold text-white">
          {period.label}
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Next period"
          className="rounded-lg px-3 py-2 text-ink-300 hover:bg-ink-800 hover:text-white"
        >
          →
        </button>
      </div>
      <div className="flex rounded-xl border border-ink-700 bg-ink-900/50 p-1">
        {(["month", "quarter", "year"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => switchKind(kind)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              period.kind === kind ? "bg-accent-400 text-ink-950" : "text-ink-300 hover:text-white"
            }`}
          >
            {kind}
          </button>
        ))}
      </div>
    </div>
  );
}
