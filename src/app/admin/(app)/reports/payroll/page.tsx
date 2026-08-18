import { requirePageStaff } from "@/lib/auth/page";
import { roleHas } from "@/lib/auth/permissions";
import { getPeriodWindow, type PeriodKind } from "@/lib/books";
import { getPayrollSnapshot } from "@/lib/payroll";
import { getSettings } from "@/lib/settings";
import { localDateISO } from "@/lib/tz";
import { PayrollReport } from "./payroll-report";

export const dynamic = "force-dynamic";

const KINDS: PeriodKind[] = ["month", "quarter", "year"];

export default async function PayrollReportPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; y?: string; i?: string }>;
}) {
  const staff = await requirePageStaff("view_financial_reports");
  const settings = await getSettings();
  const params = await searchParams;
  const today = localDateISO(settings.timezone);
  const [thisYear, thisMonth] = today.split("-").map(Number);

  const kind = KINDS.includes(params.kind as PeriodKind) ? (params.kind as PeriodKind) : "month";
  const year = Number(params.y) || thisYear;
  const index =
    Number(params.i) ||
    (kind === "month" ? thisMonth : kind === "quarter" ? Math.ceil(thisMonth / 3) : 1);

  let period;
  try {
    period = getPeriodWindow(kind, year, index, settings.timezone);
  } catch {
    period = getPeriodWindow("month", thisYear, thisMonth, settings.timezone);
  }
  const snapshot = await getPayrollSnapshot(period);

  return (
    <PayrollReport
      period={{
        kind: snapshot.period.kind,
        year: snapshot.period.year,
        index: snapshot.period.index,
        label: snapshot.period.label,
      }}
      today={today}
      currency={snapshot.currency}
      payroll={snapshot.payroll}
      payrollCategories={snapshot.payrollCategories}
      // Recording a payout writes an expense, so it needs manage_expenses,
      // not merely permission to read this page. Hiding the button is a
      // courtesy — createExpenseAction re-checks server-side regardless.
      canRecordPayout={roleHas(staff.role, "manage_expenses")}
    />
  );
}
