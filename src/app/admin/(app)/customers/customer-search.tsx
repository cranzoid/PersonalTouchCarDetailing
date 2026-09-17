"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Search over the whole customers table, not just the hundred rows on screen.
 *
 * This box used to be a bare GET form with no submit button, so nothing at all
 * happened until someone pressed Enter. Clearing the text and expecting the
 * full list back — the obvious thing to do, and what every other search box in
 * the admin does — left the filtered list sitting there looking like the
 * records had gone missing. Typing now searches on its own, and emptying the
 * box restores the list immediately rather than waiting out the debounce.
 *
 * The query stays in the URL because the matching is done by Postgres: the
 * server has to re-run it, and a shareable/refreshable address is worth having
 * for a list staff link each other to. `replace` rather than `push` so clearing
 * the box does not leave a trail of half-typed queries in the back button.
 */
export function CustomerSearch({
  defaultQuery,
  resultCount,
  capped,
}: {
  defaultQuery: string;
  /** Rows the server returned for the query currently in the URL. */
  resultCount: number;
  /** True when the result set hit the row limit and is not the whole story. */
  capped: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(defaultQuery);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the URL holds, as far as this component knows. Lets an empty box skip
  // the debounce without firing a duplicate navigation when it was already empty.
  const applied = useRef(defaultQuery.trim());

  function apply(next: string) {
    const trimmed = next.trim();
    if (trimmed === applied.current) return;
    applied.current = trimmed;
    startTransition(() => {
      router.replace(trimmed ? `${pathname}?q=${encodeURIComponent(trimmed)}` : pathname, {
        scroll: false,
      });
    });
  }

  function change(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    // Emptying the box is the one case that must never feel delayed — it is how
    // staff get back to the full list.
    if (next.trim().length === 0) {
      apply("");
      return;
    }
    timer.current = setTimeout(() => apply(next), 250);
  }

  // The URL can also change without this box: the back button, or the
  // "shares this number" link on a duplicate row. The sidebar keeps this
  // component mounted across those navigations, so the field has to follow the
  // query it is describing — but only when the change did not come from here,
  // or every keystroke would fight the round trip it just started.
  useEffect(() => {
    if (defaultQuery !== applied.current) {
      applied.current = defaultQuery;
      setValue(defaultQuery);
    }
  }, [defaultQuery]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <form
      className="mt-4 max-w-sm"
      role="search"
      onSubmit={(event) => {
        // Enter still works; it just skips the debounce instead of reloading
        // the page out from under the field.
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        apply(value);
      }}
    >
      <div className="relative">
        <input
          name="q"
          type="text"
          autoComplete="off"
          value={value}
          onChange={(event) => change(event.target.value)}
          placeholder="Search name, email or phone…"
          aria-label="Search customers"
          className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 pr-10 text-sm text-white placeholder:text-ink-600"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => change("")}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ink-500 outline-none transition hover:bg-ink-800 hover:text-ink-300 focus-visible:ring-2 focus-visible:ring-[#E0A93B]"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <p aria-live="polite" className="mt-1.5 text-xs text-ink-500">
        {pending
          ? "Searching…"
          : value.trim()
            ? `${resultCount} ${resultCount === 1 ? "match" : "matches"}${capped ? " (first 100 shown)" : ""}`
            : capped
              ? "Showing the 100 newest — type to search all customers"
              : `${resultCount} ${resultCount === 1 ? "customer" : "customers"}`}
      </p>
    </form>
  );
}
