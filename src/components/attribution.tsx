"use client";

import { useEffect } from "react";

const KEY = "ptcd_attribution";

export type StoredAttribution = {
  source?: string;
  medium?: string;
  campaign?: string;
  ad?: string;
  keyword?: string;
  landingPage?: string;
  referrer?: string;
  utm?: Record<string, string>;
  gclid?: string;
  fbclid?: string;
  firstTouch?: Record<string, string>;
  lastTouch?: Record<string, string>;
};

/**
 * Captures marketing attribution on landing (UTM params, click ids, referrer)
 * into localStorage. First touch is preserved forever; last touch updates on
 * any new tagged visit. Forms read this via getStoredAttribution().
 */
export function AttributionCapture() {
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const utm: Record<string, string> = {};
      for (const [k, v] of params) {
        if (k.startsWith("utm_")) utm[k] = v;
      }
      const gclid = params.get("gclid") ?? undefined;
      const fbclid = params.get("fbclid") ?? undefined;
      const hasSignal = Object.keys(utm).length > 0 || gclid || fbclid || document.referrer;

      const existing: StoredAttribution = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      const touch: Record<string, string> = {
        ...utm,
        ...(gclid ? { gclid } : {}),
        ...(fbclid ? { fbclid } : {}),
        ...(document.referrer ? { referrer: document.referrer } : {}),
        landingPage: window.location.pathname,
        at: new Date().toISOString(),
      };

      const source =
        utm.utm_source ?? (gclid ? "google_ads" : fbclid ? "meta_ads" : existing.source);

      const next: StoredAttribution = {
        ...existing,
        source,
        medium: utm.utm_medium ?? existing.medium,
        campaign: utm.utm_campaign ?? existing.campaign,
        ad: utm.utm_content ?? existing.ad,
        keyword: utm.utm_term ?? existing.keyword,
        landingPage: existing.landingPage ?? window.location.pathname,
        referrer: existing.referrer ?? (document.referrer || undefined),
        utm: Object.keys(utm).length > 0 ? utm : existing.utm,
        gclid: gclid ?? existing.gclid,
        fbclid: fbclid ?? existing.fbclid,
        firstTouch: existing.firstTouch ?? (hasSignal ? touch : undefined),
        lastTouch: hasSignal ? touch : existing.lastTouch,
      };
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // attribution is best-effort; never break the page
    }
  }, []);
  return null;
}

export function getStoredAttribution(): StoredAttribution {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
