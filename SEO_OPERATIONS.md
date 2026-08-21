# 90-Day Hamilton SEO Operations Runbook

The application release handles crawlability, canonical URLs, structured data, service content, consent-safe case studies and analytics events. The account and local-authority work below requires the business owner's verified Google/DNS access and must be completed outside the repository.

## Release prerequisites

- Point both `personaltouchcardetailing.ca` and `www.personaltouchcardetailing.ca` at the production App Service and keep the certificate valid for both hosts.
- Apply Terraform so production receives `APP_BASE_URL=https://www.personaltouchcardetailing.ca`, `PUBLIC_SITE_URL=https://www.personaltouchcardetailing.ca` and `SEO_INDEXABLE=true`. Staging must retain its slot URL and `SEO_INDEXABLE=false`.
- Keep production on GA4 web stream `G-JGYHFZP519`; staging intentionally omits `GA4_MEASUREMENT_ID` so test traffic cannot pollute reports.
- Run the database migration before the new code serves traffic. Migration `0011_even_psynapse.sql` adds the case-study tables.
- After the production swap, the release workflow verifies that the homepage, robots and sitemap contain no localhost or Azure hostname and that robots advertises the canonical sitemap.

## Google Search Console

1. Create a Domain property for `personaltouchcardetailing.ca` and verify it with the DNS TXT record. A Domain property includes both bare and `www` hosts.
2. Submit `https://www.personaltouchcardetailing.ca/sitemap.xml`.
3. Inspect and request indexing for:
   - `/`
   - `/services`
   - `/services/interior-detail`
   - `/services/ceramic-coating`
   - `/services/paint-correction`
   - `/services/paint-protection-film`
   - `/services/vehicle-tinting`
   - `/fleet`
   - `/results`
4. Confirm the selected canonical is the `www` URL and check Pages, Sitemaps, Core Web Vitals and Enhancements weekly for the first month.
5. Do not use the temporary-removals tool for the inaccessible `.com` site. If control is recovered, add page-by-page permanent redirects and complete Google's site-move process.

## GA4 verification

Use Realtime and DebugView after deployment. Complete one real test of each action and confirm exactly one event:

| Action | Event |
|---|---|
| Successful persisted booking | `booking_completed` |
| Successful persisted quote | `quote_submitted` |
| Telephone link | `phone_click` |
| Google directions link | `directions_click` |
| Service page to book/quote | `service_to_booking_click` |
| Case study to book/quote | `case_study_to_booking_click` |

Mark `booking_completed` and `quote_submitted` as key events. Do not add a second GA snippet through a plugin or Google Tag Manager unless this implementation is deliberately removed; doing both would duplicate page views and conversions.

## Google Business Profile

Use the existing profile—never create a duplicate.

- Exact name: **Personal Touch Car Detailing**
- Primary category: **Car detailing service**
- Website: `https://www.personaltouchcardetailing.ca/?utm_source=google&utm_medium=organic&utm_campaign=gbp`
- Booking: `https://www.personaltouchcardetailing.ca/book?utm_source=google&utm_medium=organic&utm_campaign=gbp_booking`
- Confirm phone, `2481 Upper James Street, Hamilton, ON`, normal hours and holiday hours against the real-world storefront.
- Add only categories and services actually offered. Keep descriptions factual and align displayed prices with the service database.
- Upload current exterior, interior, team/workspace and customer-approved result photos. Remove outdated or misleading media.
- Publish the strongest approved photo and a short factual summary whenever a case study goes live, linking to its clean case-study URL with GBP UTMs.
- Continue the existing neutral review request 24 hours after paid invoices. No incentives, filtering or review gating. Respond within two business days without exposing customer details.

UTM query strings do not create competing SEO URLs because all marketing pages self-canonicalize to their clean route.

## Case-study publishing cadence

Only owners and managers can access **Admin → Case studies**. Publish two genuine Hamilton jobs per month. A story cannot be published unless it has:

- a unique slug, complete summary/challenge/process/outcome and an active primary service;
- at least one image whose separate public consent is still active;
- staff confirmation of media consent; and
- staff confirmation that names, plates, VINs, addresses and other identifiers are absent.

Recommended 90-day schedule:

| Window | Deliverable |
|---|---|
| Days 1–30 | Interior detail and paint-correction case studies |
| Days 31–60 | Ceramic coating and PPF case studies |
| Days 61–90 | Tinting and fleet/detailing case studies |

Use only verified process/product facts. Record condition, scope, realistic limitations, outcome and maintenance guidance. Revoking a file's public consent immediately removes it from gallery and case-study output.

## Citations and local consistency

Audit Bing Places, Apple Business Connect, Facebook, Instagram, Yelp, Yellow Pages, legitimate supplier/installer directories and relevant Hamilton organizations. Use the exact same business name, address, phone and `.ca` URL. Request corrections to third-party links that still use the `.com` domain. Do not buy bulk directory links or create low-quality city pages.

Maintain a simple citation ledger with profile URL, login owner, NAP status, old-domain status, last checked date and next action.

## Performance and monthly reporting

Run mobile and desktop Lighthouse/PageSpeed checks for home, services, one priority service, results, book and quote after every material frontend release. Prioritize oversized images and third-party scripts. If warm server TTFB remains above 800 ms, profile database calls and introduce tagged server-data caching that is explicitly invalidated by service/case-study writes.

Field targets at the 75th percentile are LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1. Lab scores are diagnostics; Search Console field data is the acceptance source once enough traffic exists.

Record the first complete 28-day baseline, then report monthly on:

- indexed canonical pages and indexing exclusions;
- branded vs non-brand impressions, clicks, CTR and average position;
- GBP website, call and direction actions;
- organic bookings, quotes and phone clicks;
- review count, rating distribution and response time;
- published case studies and referring domains; and
- Core Web Vitals by template.

Rankings are monitored outcomes, not guaranteed deliverables. Evaluate whether qualified Hamilton enquiries and organic conversions are increasing before expanding content scope.
