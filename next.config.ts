import type { NextConfig } from "next";
import { resolve } from "path";

// Meta Pixel loads fbevents.js from connect.facebook.net, beacons events to
// www.facebook.com, and uses a tracking <img> on www.facebook.com for the
// noscript fallback. Nothing else in the CSP changes for it.
const META_PIXEL_SCRIPT_SRC = "https://connect.facebook.net";
const META_PIXEL_CONNECT_SRC = "https://www.facebook.com https://connect.facebook.net";
const META_PIXEL_IMG_SRC = "https://www.facebook.com";

// The Google tag (gtag.js) loads its script from googletagmanager.com and
// sends Analytics and Ads measurement requests to Google's documented tag
// endpoints. Keep these sources aligned with Google's CSP guidance.
const GOOGLE_TAG_SCRIPT_SRC = "https://www.googletagmanager.com";
const GOOGLE_TAG_CONNECT_SRC =
  "https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://www.google.com https://*.g.doubleclick.net https://pagead2.googlesyndication.com";
const GOOGLE_TAG_IMG_SRC =
  "https://www.googletagmanager.com https://*.google-analytics.com https://www.google.com https://*.g.doubleclick.net";
const GOOGLE_TAG_FRAME_SRC = "https://www.googletagmanager.com";

const scriptPolicy = process.env.NODE_ENV === "production"
  ? `script-src 'self' 'unsafe-inline' ${META_PIXEL_SCRIPT_SRC} ${GOOGLE_TAG_SCRIPT_SRC}`
  : `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${META_PIXEL_SCRIPT_SRC} ${GOOGLE_TAG_SCRIPT_SRC}`;
const contentSecurityPolicy = [
  "default-src 'self'",
  scriptPolicy,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${META_PIXEL_IMG_SRC} ${GOOGLE_TAG_IMG_SRC}`,
  "font-src 'self' data:",
  `connect-src 'self' ${META_PIXEL_CONNECT_SRC} ${GOOGLE_TAG_CONNECT_SRC}`,
  "media-src 'self'",
  `frame-src 'self' ${GOOGLE_TAG_FRAME_SRC}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  serverExternalPackages: ["pg", "bcryptjs", "pdfkit"],
  outputFileTracingRoot: resolve(process.cwd()),
  async redirects() {
    return [
      {
        // Keep the www hostname canonical for every route, including API and
        // static-file requests. Next.js preserves the incoming query string.
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "personaltouchcardetailing\\.ca",
          },
        ],
        destination: "https://www.personaltouchcardetailing.ca/:path*",
        permanent: true,
      },
    ];
  },
  experimental: {
    // Staff can upload up to 20 10 MB inspection photos in one server action.
    serverActions: { bodySizeLimit: "210mb" },
  },
  async headers() {
    return [
      {
        source: "/portal/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // The unsubscribe token identifies one recipient of one campaign. Keep
        // it out of search indexes and out of any Referer header the page's own
        // requests would otherwise leak it into.
        source: "/unsubscribe/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
