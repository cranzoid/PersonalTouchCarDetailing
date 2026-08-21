import { NextRequest, NextResponse } from "next/server";

const PUBLIC_SITE_URL = (
  process.env.PUBLIC_SITE_URL ?? "https://www.personaltouchcardetailing.ca"
).replace(/\/$/, "");
const CANONICAL_HOST = new URL(PUBLIC_SITE_URL).host;
const AZURE_STAGING_HOST = /-staging\.azurewebsites\.net(?::\d+)?$/i;

export function middleware(request: NextRequest) {
  const indexable = process.env.SEO_INDEXABLE === "true";
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const isAzureStagingHost = AZURE_STAGING_HOST.test(requestHost);

  if (indexable && !isAzureStagingHost && requestHost !== CANONICAL_HOST) {
    const destination = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, PUBLIC_SITE_URL);
    return NextResponse.redirect(destination, 308);
  }

  const response = NextResponse.next();
  if (!indexable || isAzureStagingHost) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  // The application instrumentation initializes PostgreSQL at boot. Keeping
  // middleware on the Node runtime prevents Next from trying to bundle that
  // server-only bootstrap into an Edge worker.
  runtime: "nodejs",
};
