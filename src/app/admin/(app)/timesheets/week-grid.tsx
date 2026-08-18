"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  "w-full rounded-lg border border-ink-600 bg-ink-950 px-2 py-2 text-center text-sm text-white placeholder:text-ink-600 focus:border-accent-500 focus:outline-none";

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
    for (const person of visible) {
      for (const day of week.days) {
        const dayMinutes = hoursToMinutes(hours[`${person.id}|${day}`] ?? "");
        minutes += dayMinutes;
        payCents += previewDayPayCents(person, dayMinutes);
      }
    }
    return { minutes, payCents };
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
    <div className="max-w-6xl pb-24">
      <h1 className="text-2xl font-bold text-white">Hours</h1>
      <p className="mt-1 text-sm text-ink-400">
        Who worked, and for how long. Feeds the payroll balance in Reports. Leave a day blank if
        they did not work it.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <WeekNav weekStart={week.weekStart} label={week.label} />
        {week.weekStart !== thisWeekStart && (
          <Link
            href={`/admin/timesheets?week=${thisWeekStart}`}
            className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-medium text-ink-200 hover:bg-ink-800"
          >
            This week
          </Link>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-ink-700 p-8 text-center text-sm text-ink-400">
          No staff accounts yet.{" "}
          <Link href="/admin/staff" className="text-accent-300 hover:underline">
            Add one
          </Link>{" "}
          and set their pay type and rate before logging hours.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
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
        <div className="sticky bottom-0 mt-6 -mx-4 border-t border-ink-700 bg-ink-950/95 px-4 py-3 backdrop-blur md:-mx-7 md:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-300">
              Week total{" "}
              <span className="font-semibold text-white">
                {(totals.minutes / 60).toFixed(totals.minutes % 60 === 0 ? 0 : 1)}h
              </span>{" "}
              · <span className="font-semibold text-white">{money(totals.payCents)}</span> of hourly
              and daily pay
            </p>
            <div className="flex items-center gap-3">
              {error && <span className="text-sm text-red-400">{error}</span>}
              {saved && !dirty && <span className="text-sm text-emerald-300">{saved}</span>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !dirty}
                className="rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
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
      className={`rounded-2xl border p-4 ${person.active ? "border-ink-700 bg-ink-900/50" : "border-ink-800 opacity-70"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-semibold text-white">
            {person.name}
            {!person.active && <span className="ml-2 text-xs text-ink-500">(inactive)</span>}
          </h2>
          <p className="text-xs text-ink-400">{rateNote(person, currency)}</p>
        </div>
        <p className="text-sm text-ink-300">
          <span className="font-semibold text-white">
            {(weekMinutes / 60).toFixed(weekMinutes % 60 === 0 ? 0 : 1)}h
          </span>
          {person.payType !== "monthly_fixed" && (
            <> · <span className="font-semibold text-white">{money(weekPayCents)}</span></>
          )}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {week.days.map((day, index) => {
          const key = `${person.id}|${day}`;
          const minutes = hoursToMinutes(hours[key] ?? "");
          return (
            <label
              key={day}
              className={`rounded-xl border p-2 ${day === today ? "border-accent-500/60 bg-accent-400/5" : "border-ink-800"}`}
            >
              <span className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-ink-300">{WEEKDAYS[index]}</span>
                <span className="text-[10px] text-ink-500">{day.slice(8)}</span>
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
              <span className="mt-1 block h-4 text-center text-[10px] text-ink-500">
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
    <div className="flex items-center gap-1 rounded-xl border border-ink-700 bg-ink-900/50 p-1">
      <Link
        href={`/admin/timesheets?week=${shift(-7)}`}
        aria-label="Previous week"
        className="rounded-lg px-3 py-2 text-ink-300 hover:bg-ink-800 hover:text-white"
      >
        ←
      </Link>
      <span className="min-w-44 px-2 text-center text-sm font-semibold text-white">{label}</span>
      <Link
        href={`/admin/timesheets?week=${shift(7)}`}
        aria-label="Next week"
        className="rounded-lg px-3 py-2 text-ink-300 hover:bg-ink-800 hover:text-white"
      >
        →
      </Link>
    </div>
  );
}
