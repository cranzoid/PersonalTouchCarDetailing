"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type ServiceNavItem = { href: string; label: string; detail: string };

/**
 * The desktop Services dropdown.
 *
 * It used to be a bare `<details>`, which only closes when you click the
 * summary again — so the panel followed you across the page and had to be
 * dismissed by hand. This closes it the way a menu is expected to close: on
 * pointer leave, on a click anywhere outside, on Escape, on tabbing out, and on
 * navigating to one of its links.
 *
 * Hover opens it as well as click, because the panel is the fastest route to a
 * service and a hover-only menu is unusable on a trackpad-less setup. Keyboard
 * users get the same behaviour from the button.
 */
export function ServicesMenu({ items }: { items: readonly ServiceNavItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // A route change always closes it — including one started from inside the
  // panel, where the click handler alone would race the navigation.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={wrapper}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => {
        // Tabbing past the last link leaves the menu entirely; moving between
        // the button and its links does not.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-[0.94rem] font-medium text-[#536477] transition-colors hover:bg-[#0B2A4A]/6 hover:text-[#0B2A4A]"
      >
        Services{" "}
        <span aria-hidden="true" className={`text-[0.68rem] transition ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-12 w-80 overflow-hidden rounded-2xl border border-[#D8D1C4] bg-[#FFFEFB] p-2 shadow-[0_22px_60px_rgba(3,15,27,0.2)]">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block rounded-xl px-4 py-3 transition hover:bg-[#F2EDE3]"
            >
              <span className="block text-sm font-semibold text-[#0B2A4A]">{item.label}</span>
              <span className="mt-0.5 block text-xs text-[#6B7280]">{item.detail}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
