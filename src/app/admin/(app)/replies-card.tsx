import Link from "next/link";

export type DashboardReply = {
  id: string;
  name: string;
  phoneLabel: string | null;
  preview: string;
  atLabel: string;
  needsAttention: boolean;
};

/**
 * Unread replies, on the dashboard.
 *
 * A list rather than a count, for the same reason the attention queue is one: a
 * number nobody can act on gets ignored, and every row here is somebody who
 * texted the shop and is still waiting. It sits above the month's figures
 * deliberately — money can wait until this afternoon, a customer asking whether
 * you can fit them in tomorrow cannot.
 */
export function RepliesCard({ items, total }: { items: DashboardReply[]; total: number }) {
  return (
    <section className="mt-8 rounded-2xl border border-[#C2453C]/30 bg-[#C2453C]/5 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-[#8A3340]">
          {total === 1 ? "1 unread reply" : `${total} unread replies`}
        </h2>
        <Link href="/admin/messages" className="text-sm text-accent-300 hover:underline">
          Open replies →
        </Link>
      </div>
      <p className="mt-1 text-sm text-ink-400">
        Customers who texted back. Opening one shows the whole thread and lets you answer.
      </p>
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href="/admin/messages"
              className="block rounded-lg border border-ink-800 bg-ink-900/50 p-3 transition-colors hover:border-[#C2453C]/50"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  {item.name}
                  {item.phoneLabel && item.phoneLabel !== item.name && (
                    <span className="ml-2 text-xs font-normal text-ink-500">{item.phoneLabel}</span>
                  )}
                </span>
                <span className="text-xs text-ink-500">{item.atLabel}</span>
              </span>
              <span className="mt-0.5 block text-sm text-ink-300">{item.preview}</span>
              {item.needsAttention && (
                <span className="mt-1 inline-block rounded-full bg-[#FFF3D6] px-2 py-0.5 text-[10px] font-bold text-[#8A681F]">
                  Reads like they want out
                </span>
              )}
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
