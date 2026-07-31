import { NextResponse } from "next/server";
import { getStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { getReportingSnapshot, parseReportDays } from "@/lib/reporting";
import { buildReportCsv, EXPORT_KINDS, type ExportKind } from "@/lib/reporting-csv";

/**
 * CSV download for the reports screen. Session-gated the same way as the
 * invoice PDF route; financial figures are never cached.
 */
export async function GET(request: Request) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });
  if (!roleHas(staff.role, "view_financial_reports")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind") ?? "summary";
  if (!EXPORT_KINDS.includes(kindParam as ExportKind)) {
    return new NextResponse("Unknown export", { status: 400 });
  }
  const kind = kindParam as ExportKind;
  const days = parseReportDays(url.searchParams.get("range") ?? undefined);

  const snapshot = await getReportingSnapshot(days);
  const csv = await buildReportCsv(kind, days, snapshot);
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: snapshot.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ptcd-${kind}-${days}d-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
