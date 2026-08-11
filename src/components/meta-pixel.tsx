"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export const META_PIXEL_ID = "1736476927680989";

// The customer portal is token-gated (/portal/<token>) and serves private
// account data. Pixel page URLs would hand those tokens to Meta, so the pixel
// is never loaded and never fires there.
const EXCLUDED_PREFIXES = ["/portal"];

type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[] };

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    __ptcdMetaPixelReady?: boolean;
  }
}

function isExcluded(pathname: string) {
  return EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Fires a Meta Pixel standard event. No-ops when the pixel has not initialised
 * (script blocked, ad blocker, excluded route) so tracking can never break a
 * form submission or booking.
 */
export function trackMetaEvent(event: string, params?: Record<string, unknown>) {
  try {
    if (typeof window === "undefined" || typeof window.fbq !== "function") return;
    if (params) window.fbq("track", event, params);
    else window.fbq("track", event);
  } catch {
    // analytics is best-effort; never surface to the customer
  }
}

/** Fires the Meta `Lead` event. Call only after a confirmed server success. */
export function trackMetaLead(params?: Record<string, unknown>) {
  trackMetaEvent("Lead", params);
}

// The official base snippet, minus the `PageView` call. Init and the first
// PageView are guarded by a window flag so the pixel can only ever initialise
// once, even if the script tag is evaluated twice.
const BASE_SNIPPET = `!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
if(!window.__ptcdMetaPixelReady){window.__ptcdMetaPixelReady=true;fbq('init','${META_PIXEL_ID}');fbq('track','PageView');}`;

const NOSCRIPT_PIXEL =
  `<img height="1" width="1" style="display:none" alt="" ` +
  `src="https://www.facebook.com/tr?id=${META_PIXEL_ID}&amp;ev=PageView&amp;noscript=1" />`;

/**
 * Loads the Meta Pixel once for the whole public site and keeps PageView in
 * sync with client-side navigation.
 *
 * The initial PageView is fired by the base snippet itself; the effect below
 * only fires on subsequent route changes, so a page load never produces two
 * PageView events.
 */
export function MetaPixel() {
  const pathname = usePathname();
  const lastTracked = useRef<string | null>(null);
  const excluded = isExcluded(pathname);

  useEffect(() => {
    if (excluded) return;
    // First route of the session: the base snippet already sent its PageView.
    if (lastTracked.current === null) {
      lastTracked.current = pathname;
      return;
    }
    if (lastTracked.current === pathname) return;
    lastTracked.current = pathname;
    trackMetaEvent("PageView");
  }, [pathname, excluded]);

  if (excluded) return null;

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">
        {BASE_SNIPPET}
      </Script>
      {/* Set as raw HTML: browsers parse <noscript> children as text when JS is
          enabled, so rendering them as JSX children causes a hydration mismatch. */}
      <noscript dangerouslySetInnerHTML={{ __html: NOSCRIPT_PIXEL }} />
    </>
  );
}
