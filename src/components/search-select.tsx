"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { matchesSearch } from "@/lib/option-search";

/**
 * A `<select>` you can type into.
 *
 * Every screen that raises work for a customer starts by picking one out of a
 * list that only ever grows, and a native dropdown gives staff nothing but the
 * scrollbar and the browser's own type-ahead — which only matches from the
 * start of the option text, so "Smith" never finds "Jane Smith". This trades
 * the native control for a button that opens a filtered list.
 *
 * It stays a controlled component holding an id, exactly like the select it
 * replaces, so callers keep the state they already had.
 */

export type SearchSelectOption = {
  value: string;
  /** What is shown, and what the list is ordered by. */
  label: string;
  /** Second line — contact details, plate, anything that disambiguates. */
  hint?: string;
  /** Extra terms to match on that are not worth showing. */
  searchText?: string;
};

const triggerClass =
  "flex w-full items-center justify-between gap-2 rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-left text-sm text-white disabled:opacity-50";

function optionHaystack(option: SearchSelectOption): string {
  return [option.label, option.hint, option.searchText].filter(Boolean).join(" ");
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  emptyOptionLabel,
  searchPlaceholder = "Type to search…",
  disabled = false,
  label,
  className = "",
}: {
  options: SearchSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Shown on the button when nothing is selected. */
  placeholder?: string;
  /** When set, a leading option that clears the field — e.g. "No vehicle". */
  emptyOptionLabel?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Announced to screen readers; the visible caption stays with the caller. */
  label: string;
  className?: string;
}) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const allOptions = useMemo(
    () =>
      emptyOptionLabel === undefined
        ? options
        : [{ value: "", label: emptyOptionLabel }, ...options],
    [options, emptyOptionLabel],
  );
  const visible = useMemo(
    () => (query.trim() ? allOptions.filter((o) => matchesSearch(optionHaystack(o), query)) : allOptions),
    [allOptions, query],
  );

  const selected = allOptions.find((o) => o.value === value && o.value !== "");

  // A vehicle can be removed from under the picker (the customer changes), so
  // never point the highlight past the end of the list that is actually drawn.
  const boundedIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[boundedIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, boundedIndex]);

  function openList() {
    if (disabled) return;
    setQuery("");
    // Open on the current selection, so a list of two hundred does not start at
    // the top when staff only wanted to check who was picked.
    setActiveIndex(Math.max(allOptions.findIndex((o) => o.value === value), 0));
    setOpen(true);
  }

  function close({ focusTrigger = true }: { focusTrigger?: boolean } = {}) {
    setOpen(false);
    setQuery("");
    if (focusTrigger) triggerRef.current?.focus();
  }

  function pick(optionValue: string) {
    onChange(optionValue);
    close();
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(boundedIndex + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(boundedIndex - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(visible.length - 1, 0));
    } else if (event.key === "Enter") {
      // These pickers sit inside the invoice form: without this, Enter submits
      // it instead of choosing the highlighted customer.
      event.preventDefault();
      const option = visible[boundedIndex];
      if (option) pick(option.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      close({ focusTrigger: false });
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openList();
          }
        }}
        className={triggerClass}
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <>
              <span>{selected.label}</span>
              {selected.hint && <span className="text-ink-400"> — {selected.hint}</span>}
            </>
          ) : (
            <span className="text-ink-400">{value === "" && emptyOptionLabel ? emptyOptionLabel : placeholder}</span>
          )}
        </span>
        <span aria-hidden="true" className="shrink-0 text-ink-400">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-ink-600 bg-ink-900 shadow-2xl">
          <div className="border-b border-ink-800 p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-controls={listboxId}
              aria-activedescendant={visible[boundedIndex] ? `${optionIdPrefix}-${boundedIndex}` : undefined}
              className="w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white"
            />
          </div>
          <ul ref={listRef} id={listboxId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
            {visible.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === boundedIndex;
              return (
                <li
                  key={option.value || "__none__"}
                  id={`${optionIdPrefix}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(index)}
                  // mousedown, not click: the outside-click listener would
                  // otherwise close the list before the click ever landed.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(option.value);
                  }}
                  className={`cursor-pointer px-3 py-2 text-sm ${isActive ? "bg-ink-800" : ""} ${
                    isSelected ? "text-accent-300" : "text-white"
                  }`}
                >
                  <span className="block truncate">{option.label}</span>
                  {option.hint && <span className="block truncate text-xs text-ink-400">{option.hint}</span>}
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="px-3 py-3 text-sm text-ink-400">No match for “{query.trim()}”.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
