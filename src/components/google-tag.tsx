"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export const GOOGLE_ADS_ID = "AW-18382460932";

// The customer portal is token-gated (/portal/<token>) and serves private
// account data. gtag sends the page URL with every hit, so -- same rule as
// the Meta Pixel -- it is never loaded and never fires there.
const EXCLUDED_PREFIXES = ["/portal"];

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function isExcluded(pathname: string) {
  return EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// The official base snippet. Config runs once on load; the effect below
// covers client-side route changes, which gtag does not see on its own.
const INIT_SNIPPET = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${GOOGLE_ADS_ID}');`;

/**
 * Loads the Google tag once for the whole public site and sends a page_view
 * on client-side route changes, so soft navigation between marketing pages
 * is tracked without double-counting the initial load.
 */
export function GoogleTag() {
  const pathname = usePathname();
  const lastTracked = useRef<string | null>(null);
  const excluded = isExcluded(pathname);

  useEffect(() => {
    if (excluded) return;
    // First route of the session: the init snippet's own `config` call
    // already sent this page_view.
    if (lastTracked.current === null) {
      lastTracked.current = pathname;
      return;
    }
    if (lastTracked.current === pathname) return;
    lastTracked.current = pathname;
    if (typeof window.gtag === "function") {
      window.gtag("event", "page_view", { page_path: pathname });
    }
  }, [pathname, excluded]);

  if (excluded) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-tag-init" strategy="afterInteractive">
        {INIT_SNIPPET}
      </Script>
    </>
  );
}
