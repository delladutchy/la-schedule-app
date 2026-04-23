/**
 * Day / slot generation in a specific IANA timezone.
 *
 * We use Luxon because:
 *   - It understands IANA zones natively (unlike plain Date).
 *   - `DateTime.plus({ hours: N })` correctly handles DST transitions:
 *     on "spring forward" days, 10:00 local time still lands on the right
 *     wall-clock hour, not on a wrong UTC offset.
 *   - It gives us explicit `zone` tracking so bugs are easy to spot.
 *
 * IMPORTANT DST NOTE:
 *   When we render a workday from 9:00 to 18:00 local, the actual UTC
 *   range shifts by ±1h depending on DST. We always compute the
 *   start-of-day in zone, then derive workday boundaries from that,
 *   which is DST-safe.
 */

import { DateTime } from "luxon";
import type { Interval } from "./intervals";

export interface WorkdayWindow {
  /** Local day as YYYY-MM-DD. */
  dateKey: string;
  /** Short label for display ("Mon, Oct 14"). */
  label: string;
  /** Is this date a Saturday or Sunday in the display zone? */
  isWeekend: boolean;
  /** Workday start/end in UTC ms. */
  startMs: number;
  endMs: number;
  /** Interval form for convenience. */
  frame: Interval;
}

/**
 * Build one WorkdayWindow per day in the range [fromIsoDate, toIsoDate),
 * inclusive of `fromIsoDate` and exclusive of `toIsoDate`, in the given
 * IANA timezone.
 */
export function buildWorkdayWindows(
  fromIsoDate: string, // YYYY-MM-DD
  days: number,
  workdayStartHour: number,
  workdayEndHour: number,
  timezone: string,
): WorkdayWindow[] {
  const start = DateTime.fromISO(fromIsoDate, { zone: timezone });
  if (!start.isValid) {
    throw new Error(`Invalid fromIsoDate "${fromIsoDate}" for zone ${timezone}`);
  }

  const windows: WorkdayWindow[] = [];
  for (let i = 0; i < days; i++) {
    const day = start.plus({ days: i });
    const wdStart = day.set({
      hour: workdayStartHour, minute: 0, second: 0, millisecond: 0,
    });
    const wdEnd = day.set({
      hour: workdayEndHour === 24 ? 0 : workdayEndHour,
      minute: 0, second: 0, millisecond: 0,
    }).plus({ days: workdayEndHour === 24 ? 1 : 0 });

    // DST guard: on a spring-forward day, 2:00 local may not exist.
    // Luxon returns an invalid DateTime; fall back to next valid hour.
    const safeStart = wdStart.isValid ? wdStart : day.startOf("day").plus({ hours: workdayStartHour });
    const safeEnd = wdEnd.isValid ? wdEnd : day.startOf("day").plus({ hours: workdayEndHour });

    const startMs = safeStart.toUTC().toMillis();
    const endMs = safeEnd.toUTC().toMillis();

    windows.push({
      dateKey: day.toFormat("yyyy-LL-dd"),
      label: day.toFormat("EEE, LLL d"),
      isWeekend: day.weekday === 6 || day.weekday === 7,
      startMs,
      endMs,
      frame: { startMs, endMs },
    });
  }

  return windows;
}

/**
 * Break a workday window into fixed-size slots, aligned to the workday start.
 * Returns slots as Intervals with UTC ms boundaries.
 */
export function sliceIntoSlots(window: WorkdayWindow, slotMinutes: number): Interval[] {
  if (60 % slotMinutes !== 0) {
    throw new Error(`slotMinutes must divide 60 evenly, got ${slotMinutes}`);
  }
  const slotMs = slotMinutes * 60 * 1000;
  const slots: Interval[] = [];
  let t = window.startMs;
  while (t < window.endMs) {
    const end = Math.min(t + slotMs, window.endMs);
    slots.push({ startMs: t, endMs: end });
    t = end;
  }
  return slots;
}

/** Format a UTC ms timestamp as a local wall-clock time in the given zone. */
export function formatLocalTime(utcMs: number, timezone: string): string {
  return DateTime.fromMillis(utcMs, { zone: "utc" })
    .setZone(timezone)
    .toFormat("h:mm a");
}

/** Format a UTC ms timestamp as ISO in the given zone (with offset). */
export function toZonedIso(utcMs: number, timezone: string): string {
  return DateTime.fromMillis(utcMs, { zone: "utc" })
    .setZone(timezone)
    .toISO() as string;
}

/** The current date (YYYY-MM-DD) in the given zone. */
export function todayInZone(timezone: string, nowMs: number = Date.now()): string {
  return DateTime.fromMillis(nowMs, { zone: "utc" })
    .setZone(timezone)
    .toFormat("yyyy-LL-dd");
}

/**
 * Humanize an age in minutes as "X min ago", "X hr ago", etc.
 */
export function humanizeAge(ageMinutes: number): string {
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} min ago`;
  const hours = ageMinutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hr ago`;
  const days = hours / 24;
  return `${days.toFixed(1)} days ago`;
}
