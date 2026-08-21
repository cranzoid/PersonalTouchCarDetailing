"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { trackGa4Event } from "./google-tag";

/** Delegated tracking keeps phone, direction and high-intent links consistent. */
export function SeoClickTracking() {
  const pathname = usePathname();

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = anchor.getAttribute("href") ?? "";
      const explicit = anchor.dataset.analyticsEvent;
      if (explicit) {
        trackGa4Event(explicit, { link_url: anchor.href, page_path: pathname });
        return;
      }
      if (href.startsWith("tel:")) {
        trackGa4Event("phone_click", { page_path: pathname });
        return;
      }

      let destination: URL;
      try {
        destination = new URL(anchor.href, window.location.origin);
      } catch {
        return;
      }
      const isHighIntent = destination.pathname === "/book" || destination.pathname === "/quote";
      if (isHighIntent && pathname.startsWith("/services")) {
        trackGa4Event("service_to_booking_click", { source_path: pathname, destination_path: destination.pathname });
      } else if (isHighIntent && pathname.startsWith("/results")) {
        trackGa4Event("case_study_to_booking_click", { source_path: pathname, destination_path: destination.pathname });
      }
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [pathname]);

  return null;
}
