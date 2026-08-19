"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FinanceMetric,
  FinanceWorkspaceHeader,
  financeButton,
  financePrimaryButton,
} from "@/components/finance-workspace";
import { formatCents } from "@/lib/money";
import { PAY_TYPE_LABELS, type PayType } from "@/lib/types";
import { saveTimesheetWeekAction } from "./actions";

type StaffRow = {
  id: string;
  name: string;
  active: boolean;
  payType: PayType;
  hourlyRateCents: number;
  dailyRateCents: number;
  monthlySalaryCents: number;
};

type Cell = { minutes: number; payEarnedCents: number; notes: string | null };

type Week = {
  weekStart: string;
  label: string;
  days: string[];
  staff: StaffRow[];
  entries: Record<string, Record<string, Cell>>;
};

const inputClass =
  "w-full min-h-11 rounded-xl border border-[#C9D5E0] bg-white px-2 py-2 text-center text-sm font-semibold text-[#17344F] shadow-sm outline-none placeholder:text-[#A0ADBA] focus:border-[#0B2A4A] focus:ring-2 focus:ring-[#E0A93B]/35";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Hours in the box, minutes in the database. 7.5 -> 450, and "" -> 0. */
function hoursToMinutes(hours: string): number {
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 60);
}
const minutesToHours = (minutes: number) => (minutes === 0 ? "" : String(+(minutes / 60).toFixed(2)));

/**
 * What this day will earn, mirroring computeDayPayCents in src/lib/payroll.ts.
 * A live preview only — the server recomputes and is the value that is stored.
 */
function previewDayPayCents(person: StaffRow, minutes: number): number {
  if (minutes <= 0) return 0;
  if (person.payType === "hourly") return Math.round((minutes * person.hourlyRateCents) / 60);
  if (person.payType === "daily_fixed") return person.dailyRateCents;
  return 0;
}

function rateNote(person: StaffRow, currency: string): string {
  const label = PAY_TYPE_LABELS[person.payType];
  if (person.payType === "hourly") {
    return person.hourlyRateCents === 0
      ? `${label} — no rate set yet`
      : `${label} · ${formatCents(person.hourlyRateCents, currency)}/h`;
  }
  if (person.payType === "daily_fixed") {
    return person.dailyRateCents === 0
      ? `${label} — no rate set yet`
      : `${label} · ${formatCents(person.dailyRateCents, currency)}/day`;
  }
  return `${label} · ${formatCents(person.monthlySalaryCents, currency)}/month — hours are logged, pay accrues monthly`;
}

export function TimesheetWeekGrid({
  week,
  today,
  thisWeekStart,
  currency,
}: {
  week: Week;
  today: string;
  thisWeekStart: string;
  currency: string;
}) {
  const router = useRouter();
  const money = (cents: number) => formatCents(cents, currency);

  // Keyed by `${staffId}|${day}` so a cell is addressable without nesting.
  const [hours, setHours] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const person of week.staff) {
      for (const day of week.days) {
        initial[`${person.id}|${day}`] = minutesToHours(week.entries[person.id]?.[day]?.minutes ?? 0);
      }
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Deactivated staff are hidden unless they already have hours this week: a
  // grid of everyone who ever worked here would be unusable within a year.
  const visible = week.staff.filter(
    (person) => person.active || week.days.some((day) => week.entries[person.id]?.[day]),
  );

  const totals = useMemo(() => {
    let minutes = 0;
    let payCents = 0;
    const people = new Set<string>();
    const days = new Set<string>();
    for (const person of visible) {
      for (const day of week.days) {
        const dayMinutes = hoursToMinutes(hours[`${person.id}|${day}`] ?? "");
        minutes += dayMinutes;
        payCents += previewDayPayCents(person, dayMinutes);
        if (dayMinutes > 0) {
          people.add(person.id);
          days.add(day);
        }
      }
    }
    return { minutes, payCents, people: people.size, days: days.size };
  }, [hours, visible, week.days]);

  const dirty = visible.some((person) =>
    week.days.some(
      (day) =>
        hoursToMinutes(hours[`${person.id}|${day}`] ?? "") !==
        (week.entries[person.id]?.[day]?.minutes ?? 0),
    ),
  );

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    // Only changed cells are sent. Re-sending the whole grid would rewrite
    // untouched days and re-freeze their pay at today's rate, quietly
    // backdating a raise onto shifts that were already settled.
    const entries = visible.flatMap((person) =>
      week.days
        .map((day) => ({
          staffUserId: person.id,
          workDate: day,
          minutes: hoursToMinutes(hours[`${person.id}|${day}`] ?? ""),
        }))
        .filter((entry) => entry.minutes !== (week.entries[person.id]?.[entry.workDate]?.minutes ?? 0)),
    );
    if (entries.length === 0) {
      setBusy(false);
      return;
    }
    const result = await saveTimesheetWeekAction({ entries });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(`${result.saved} ${result.saved === 1 ? "day" : "days"} saved.`);
    router.refresh();
  }

  return (
    <div className="max-w-[88rem] pb-24">
      <FinanceWorkspaceHeader
        active="hours"
        title="Staff hours"
        description="Enter the time each person worked. Saved hours freeze hourly and day-rate earnings for payroll; salaried staff hours remain an activity record."
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#DCE4EC] bg-white p-4 shadow-[0_8px_24px_rgba(11,42,74,0.04)]">
        <WeekNav weekStart={week.weekStart} label={week.label} />
        {week.weekStart !== thisWeekStart && (
          <Link
            href={`/admin/timesheets?week=${thisWeekStart}`}
            className={financeButton}
          >
            This week
          </Link>
        )}
      </div>

      {visible.length > 0 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <FinanceMetric
            label="Hours this week"
            value={`${(totals.minutes / 60).toFixed(totals.minutes % 60 === 0 ? 0 : 1)}h`}
            detail={`${totals.days} ${totals.days === 1 ? "day has" : "days have"} time entered`}
            tone="accent"
          />
          <FinanceMetric
            label="Hourly & day-rate earnings"
            value={money(totals.payCents)}
            detail="Live estimate; the server confirms and freezes pay when saved"
            tone="positive"
          />
          <FinanceMetric
            label="Staff with time"
            value={`${totals.people} of ${visible.length}`}
            detail="Leave a day empty when a person did not work"
          />
        </div>
      )}

      {visible.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-[#C9D5E0] bg-white p-8 text-center text-sm text-[#687B8E]">
          No staff accounts yet.{" "}
          <Link href="/admin/staff" className="text-accent-300 hover:underline">
            Add one
          </Link>{" "}
          and set their pay type and rate before logging hours.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {visible.map((person) => (
            <StaffWeek
              key={person.id}
              person={person}
              week={week}
              today={today}
              hours={hours}
              onHours={(key, value) => setHours((current) => ({ ...current, [key]: value }))}
              money={money}
              currency={currency}
            />
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div className="sticky bottom-3 z-20 mt-6 rounded-2xl border border-[#CCD7E1] bg-white/95 px-4 py-3 shadow-[0_16px_42px_rgba(11,42,74,0.16)] backdrop-blur md:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[#5D7084]">
              Week total{" "}
              <span className="font-semibold text-[#0B2A4A]">
                {(totals.minutes / 60).toFixed(totals.minutes % 60 === 0 ? 0 : 1)}h
              </span>{" "}
              · <span className="font-semibold text-[#0B2A4A]">{money(totals.payCents)}</span> of hourly
              and daily pay
            </p>
            <div className="flex items-center gap-3">
              {error && <span className="text-sm text-red-400">{error}</span>}
              {saved && !dirty && <span className="text-sm text-emerald-300">{saved}</span>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !dirty}
                className={financePrimaryButton}
              >
                {busy ? "Saving…" : dirty ? "Save hours" : "Saved"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One staff member's week: seven day boxes that stack on a phone. */
function StaffWeek({
  person,
  week,
  today,
  hours,
  onHours,
  money,
  currency,
}: {
  person: StaffRow;
  week: Week;
  today: string;
  hours: Record<string, string>;
  onHours: (key: string, value: string) => void;
  money: (cents: number) => string;
  currency: string;
}) {
  const weekMinutes = week.days.reduce(
    (total, day) => total + hoursToMinutes(hours[`${person.id}|${day}`] ?? ""),
    0,
  );
  const weekPayCents = week.days.reduce(
    (total, day) => total + previewDayPayCents(person, hoursToMinutes(hours[`${person.id}|${day}`] ?? "")),
    0,
  );

  return (
    <article
      className={`overflow-hidden rounded-2xl border bg-white shadow-[0_8px_24px_rgba(11,42,74,0.04)] ${person.active ? "border-[#DCE4EC]" : "border-[#E5E9EE] opacity-70"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E7ECF1] bg-[#FAFBFC] px-4 py-4 sm:px-5">
        <div>
          <h2 className="font-semibold text-[#0B2A4A]">
            {person.name}
            {!person.active && <span className="ml-2 text-xs text-ink-500">(inactive)</span>}
          </h2>
          <p className="mt-0.5 text-xs text-[#6B7D90]">{rateNote(person, currency)}</p>
        </div>
        <p className="rounded-xl border border-[#DDE5EC] bg-white px-3 py-2 text-sm text-[#607386] shadow-sm">
          <span className="font-semibold text-[#0B2A4A]">
            {(weekMinutes / 60).toFixed(weekMinutes % 60 === 0 ? 0 : 1)}h
          </span>
          {person.payType !== "monthly_fixed" && (
            <> · <span className="font-semibold text-white">{money(weekPayCents)}</span></>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 sm:p-5 lg:grid-cols-7">
        {week.days.map((day, index) => {
          const key = `${person.id}|${day}`;
          const minutes = hoursToMinutes(hours[key] ?? "");
          return (
            <label
              key={day}
              className={`rounded-xl border p-2.5 ${
                day === today
                  ? "border-[#E0A93B] bg-[#FFF9EB] shadow-[inset_0_0_0_1px_rgba(224,169,59,0.18)]"
                  : index > 4
                    ? "border-[#E2E7ED] bg-[#F8FAFC]"
                    : "border-[#DDE5EC] bg-white"
              }`}
            >
              <span className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-[#435B71]">{WEEKDAYS[index]}</span>
                <span className="text-[10px] text-[#8493A2]">{day.slice(8)}</span>
              </span>
              <input
                type="number"
                step="0.25"
                min="0"
                max="24"
                inputMode="decimal"
                placeholder="0"
                aria-label={`Hours for ${person.name} on ${day}`}
                value={hours[key] ?? ""}
                onChange={(event) => onHours(key, event.target.value)}
                className={`${inputClass} mt-1`}
              />
              <span className="mt-1 block h-4 text-center text-[10px] font-medium text-[#718296]">
                {minutes > 0 && person.payType !== "monthly_fixed"
                  ? money(previewDayPayCents(person, minutes))
                  : ""}
              </span>
            </label>
          );
        })}
      </div>
    </article>
  );
}

/** Previous / next week, one link each — the whole navigation this screen needs. */
function WeekNav({ weekStart, label }: { weekStart: string; label: string }) {
  const shift = (days: number) => {
    const [year, month, day] = weekStart.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  return (
    <div className="flex items-center gap-1 rounded-xl border border-[#D4DEE7] bg-[#F5F7FA] p-1">
      <Link
        href={`/admin/timesheets?week=${shift(-7)}`}
        aria-label="Previous week"
        className="rounded-lg px-3 py-2 text-[#607386] hover:bg-white hover:text-[#0B2A4A]"
      >
        ←
      </Link>
      <span className="min-w-44 px-2 text-center text-sm font-semibold text-[#0B2A4A]">{label}</span>
      <Link
        href={`/admin/timesheets?week=${shift(7)}`}
        aria-label="Next week"
        className="rounded-lg px-3 py-2 text-[#607386] hover:bg-white hover:text-[#0B2A4A]"
      >
        →
      </Link>
    </div>
  );
}
