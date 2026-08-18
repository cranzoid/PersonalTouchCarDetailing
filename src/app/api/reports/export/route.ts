import { NextResponse } from "next/server";
import { getStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { getReportingSnapshot, parseReportDays } from "@/lib/reporting";
import {
  BOOKS_EXPORT_KINDS,
  buildReportCsv,
  EXPORT_KINDS,
  parsePeriodKind,
  type ExportKind,
} from "@/lib/reporting-csv";
import { getBooksSnapshot } from "@/lib/books";
import { localDateISO } from "@/lib/tz";

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

  // The books exports run on a calendar period rather than a rolling window, so
  // they carry their own parameters and their own filename suffix.
  let books;
  let suffix = `${days}d`;
  if (BOOKS_EXPORT_KINDS.includes(kind)) {
    const [thisYear, thisMonth] = localDateISO(snapshot.timezone).split("-").map(Number);
    const periodKind = parsePeriodKind(url.searchParams.get("kindPeriod"));
    const year = Number(url.searchParams.get("y")) || thisYear;
    const index =
      Number(url.searchParams.get("i")) ||
      (periodKind === "month" ? thisMonth : periodKind === "quarter" ? Math.ceil(thisMonth / 3) : 1);
    try {
      books = await getBooksSnapshot(periodKind, year, index);
    } catch {
      return new NextResponse("Invalid period", { status: 400 });
    }
    suffix = `${books.period.year}-${periodKind}${periodKind === "year" ? "" : books.period.index}`;
  }

  const csv = await buildReportCsv(kind, days, snapshot, new Date(), books);
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: snapshot.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ptcd-${kind}-${suffix}-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
