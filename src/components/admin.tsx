export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    confirmed: "bg-emerald-500/15 text-emerald-300",
    pending: "bg-amber-500/15 text-amber-300",
    deposit_required: "bg-amber-500/15 text-amber-300",
    arrived: "bg-sky-500/15 text-sky-300",
    cancelled: "bg-red-500/15 text-red-300",
    no_show: "bg-red-500/15 text-red-300",
    completed: "bg-ink-700 text-ink-300",
    converted: "bg-violet-500/15 text-violet-300",
    rescheduled: "bg-sky-500/15 text-sky-300",
    new: "bg-amber-500/15 text-amber-300",
    contacted: "bg-sky-500/15 text-sky-300",
    qualified: "bg-emerald-500/15 text-emerald-300",
    lost: "bg-ink-700 text-ink-400",
    reviewing: "bg-sky-500/15 text-sky-300",
    estimated: "bg-emerald-500/15 text-emerald-300",
    closed: "bg-ink-700 text-ink-400",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs capitalize ${colors[status] ?? "bg-ink-700 text-ink-300"}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
