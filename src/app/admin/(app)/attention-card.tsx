import Link from "next/link";
import type { AttentionItem } from "@/lib/attention";

/**
 * The "needs attention" card (spec §5). Deliberately a list of links rather
 * than a count: a number nobody can act on gets ignored, and each row here is
 * cleared by opening the record and finishing it.
 */
export function AttentionCard({ items, total }: { items: AttentionItem[]; total: number }) {
  return (
    <section className="mt-8 rounded-2xl border border-amber-500/30 bg-amber-950/10 p-5">
      <h2 className="font-semibold text-amber-200">{`Needs attention (${total})`}</h2>
      <p className="mt-1 text-sm text-ink-400">
        Nothing here is broken — these are records that look unfinished. They clear as you fix them.
      </p>
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <Link
              href={item.href}
              className="block rounded-lg border border-ink-800 bg-ink-900/50 p-3 transition-colors hover:border-amber-500/50"
            >
              <span className="block text-sm text-white">{item.label}</span>
              <span className="block text-xs text-ink-500">{item.detail}</span>
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
