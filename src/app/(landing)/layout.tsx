import type { ReactNode } from "react";
import { AttributionCapture } from "@/components/attribution";
import { MetaPixel } from "@/components/meta-pixel";
import { GoogleTag } from "@/components/google-tag";

// Landing pages read business settings and the catalogue from PostgreSQL.
export const dynamic = "force-dynamic";

/**
 * Chrome for paid-traffic landing pages.
 *
 * Deliberately NOT the public site layout. A direct-response page has one job,
 * and the site header is nine ways to leave it before the form is filled in —
 * every one of them a visitor who cost money to bring here. What is kept is the
 * measurement (attribution, both pixels), because a landing page that cannot be
 * attributed is an advertising spend nobody can judge, and the trust signals,
 * which the page itself carries.
 */
export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-ink-950">
      <AttributionCapture />
      <MetaPixel />
      <GoogleTag ga4MeasurementId={process.env.GA4_MEASUREMENT_ID} />
      {children}
    </div>
  );
}
