/**
 * Timezone helpers. The database stores UTC; all availability math happens in
 * the business timezone (settings.timezone, default America/Toronto).
 * No external tz library — Intl provides offsets.
 */

function tzOffsetMs(timeZone: string, utcDate: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(utcDate)) map[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - utcDate.getTime();
}

/** Convert business-local wall time to a UTC Date (DST-safe two-pass). */
export function zonedToUtc(
  timeZone: string,
  y: number,
  m: number, // 1-12
  d: number,
  hh: number,
  mm: number,
): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const guess = naive - tzOffsetMs(timeZone, new Date(naive));
  return new Date(naive - tzOffsetMs(timeZone, new Date(guess)));
}

/** Weekday (0=Sunday) of a calendar date in the business timezone. */
export function zonedWeekday(timeZone: string, y: number, m: number, d: number): number {
  // Noon local avoids DST edge ambiguity.
  const utc = zonedToUtc(timeZone, y, m, d, 12, 0);
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(utc);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function formatInZone(
  date: Date,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, ...opts }).format(date);
}

export function parseHHMM(s: string): { hh: number; mm: number } {
  const [hh, mm] = s.split(":").map(Number);
  return { hh, mm };
}
