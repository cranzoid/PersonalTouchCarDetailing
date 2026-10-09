import Link from "next/link";

export type DashboardFollowUp = {
  id: string;
  name: string;
  callback: boolean;
  vehicle: string;
  dueLabel: string;
  overdue: boolean;
  lastLabel: string;
};

/**
 * Quote and callback requests whose follow-up day has come.
 *
 * A list of people rather than a count, like the replies and attention cards:
 * each row is someone who asked for a price and is waiting to hear back, and
 * opening it is where the follow-up gets sent.
 */
export function FollowUpsCard({ items, total }: { items: DashboardFollowUp[]; total: number }) {
  return (
    <section className="mt-8 rounded-2xl border border-amber-500/30 bg-amber-950/10 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-amber-300">
          {total === 1 ? "1 follow-up due" : `${total} follow-ups due`}
        </h2>
        <Link href="/admin/leads?tab=quotes&filter=due" className="text-sm text-accent-300 hover:underline">
          All due →
        </Link>
      </div>
      <p className="mt-1 text-sm text-ink-400">
        Quote and callback requests waiting to hear back. Text, email or log a call from each one.
      </p>
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/admin/leads/quotes/${item.id}`}
              className="block rounded-lg border border-ink-800 bg-ink-900/50 p-3 transition-colors hover:border-amber-500/50"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  {item.name}
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {item.callback ? "Callback" : "Quote"}
                    {item.vehicle ? ` · ${item.vehicle}` : ""}
                  </span>
                </span>
                <span className={`text-xs ${item.overdue ? "font-semibold text-amber-300" : "text-ink-500"}`}>
                  {item.dueLabel}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-ink-400">{item.lastLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="mt-3 text-xs text-ink-500">
          Showing {items.length} of {total}.
        </p>
      )}
    </section>
  );
}
