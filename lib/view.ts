/**
 * View model.
 *
 * Takes a validated Snapshot and produces a list of DayView objects
 * that the page can render directly. Pure function — no I/O.
 *
 * Freshness classification:
 *   - age <= freshTtlMinutes       → "ok"
 *   - age <= hardTtlMinutes        → "stale" (render with warning)
 *   - age >  hardTtlMinutes        → "unavailable" (fail closed)
 *   - snapshot === null            → "unavailable"
 */

import type { DayStatus, DayView, DaySlot, RenderState, Snapshot, SnapshotStatus } from "./types";
import {
  buildWorkdayWindows,
  sliceIntoSlots,
  toZonedIso,
  formatLocalTime,
  todayInZone,
} from "./time";
import type { Interval } from "./intervals";
import { overlapsAny, isOverlapTentative } from "./intervals";
import { DateTime } from "luxon";

export interface ClassifyOptions {
  freshTtlMinutes: number;
  hardTtlMinutes: number;
}

export function classifySnapshot(
  snapshot: Snapshot | null,
  nowMs: number,
  opts: ClassifyOptions,
): RenderState {
  if (!snapshot) {
    return { status: "unavailable", snapshot: null, ageMinutes: null,
      reason: "No snapshot available." };
  }
  const generatedMs = Date.parse(snapshot.generatedAtUtc);
  if (!Number.isFinite(generatedMs)) {
    return { status: "unavailable", snapshot: null, ageMinutes: null,
      reason: "Snapshot timestamp invalid." };
  }
  const ageMinutes = Math.max(0, (nowMs - generatedMs) / 60000);
  let status: SnapshotStatus;
  if (ageMinutes <= opts.freshTtlMinutes) status = "ok";
  else if (ageMinutes <= opts.hardTtlMinutes) status = "stale";
  else status = "unavailable";

  return {
    status,
    snapshot: status === "unavailable" ? null : snapshot,
    ageMinutes,
    ...(status === "unavailable"
      ? { reason: `Snapshot is ${Math.round(ageMinutes)} minutes old; beyond hard TTL.` }
      : {}),
  };
}

export interface BuildDayViewsOptions {
  snapshot: Snapshot;
  /** Which YYYY-MM-DD to start the view at, in display timezone. */
  startDate: string;
  /** Number of days to render. */
  days: number;
  /** Slot granularity in minutes. */
  slotMinutes: 15 | 30 | 60;
}

export function buildDayViews(opts: BuildDayViewsOptions): DayView[] {
  const { snapshot, startDate, days, slotMinutes } = opts;
  const tz = snapshot.config.timezone;

  const windows = buildWorkdayWindows(
    startDate,
    days,
    snapshot.config.workdayStartHour,
    snapshot.config.workdayEndHour,
    tz,
  );

  // Convert snapshot busy blocks to UTC ms intervals (once).
  const busy: Interval[] = snapshot.busy
    .map((b) => ({
      startMs: Date.parse(b.startUtc),
      endMs: Date.parse(b.endUtc),
      tentative: b.tentative,
    }))
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const dayViews: DayView[] = [];

  for (const w of windows) {
    const rawSlots = sliceIntoSlots(w, slotMinutes);
    const slots: DaySlot[] = rawSlots.map((s) => {
      const startIso = toZonedIso(s.startMs, tz);
      const endIso = toZonedIso(s.endMs, tz);
      if (!overlapsAny(s, busy)) {
        return { startIso, endIso, status: "available" };
      }
      if (snapshot.config.showTentative && isOverlapTentative(s, busy)) {
        return { startIso, endIso, status: "tentative" };
      }
      return { startIso, endIso, status: "busy" };
    });

    // Summary heuristics.
    const total = slots.length;
    const available = slots.filter((s) => s.status === "available").length;
    let summary: string;
    if (total === 0) summary = "No hours";
    else if (available === 0) summary = "Fully booked";
    else if (available === total) summary = "Fully available";
    else if (available / total >= 0.6) summary = "Mostly available";
    else if (available / total >= 0.3) summary = "Limited availability";
    else summary = "Mostly booked";

    dayViews.push({
      date: w.dateKey,
      label: w.label,
      isWeekend: w.isWeekend,
      slots,
      summary,
    });
  }

  return dayViews;
}

/** Format a slot's time range for display, e.g. "9:00 – 9:30 AM". */
export function formatSlotRange(slot: DaySlot, timezone: string): string {
  const startMs = Date.parse(slot.startIso);
  const endMs = Date.parse(slot.endIso);
  return `${formatLocalTime(startMs, timezone)} – ${formatLocalTime(endMs, timezone)}`;
}

/** Build a human-readable "today" label for initial view in the display zone. */
export function initialStartDate(
  snapshot: Snapshot,
  nowMs: number = Date.now(),
): string {
  return todayInZone(snapshot.config.timezone, nowMs);
}

// ---------- Day-board (employer-facing) view ----------

export interface BuildDayBoardOptions {
  snapshot: Snapshot;
  /** Start date in display timezone, YYYY-MM-DD. Will be anchored to its Monday. */
  startDate: string;
  /** How many weeks to render (1 = this week; 2 = this week + next). */
  weeks: 1 | 2;
  /** IANA timezone to render in. Falls back to snapshot.config.timezone. */
  timezone?: string;
  /** Workday start hour in display tz. Used to define the "this day" window. */
  workdayStartHour: number;
  /** Workday end hour in display tz (exclusive). */
  workdayEndHour: number;
  /** Now, for highlighting today. */
  nowMs?: number;
}

export interface WeekGroup {
  /** Monday of the week, YYYY-MM-DD. */
  weekOf: string;
  /** Human label, e.g. "Week of Apr 21". */
  label: string;
  days: DayStatus[];
}

export interface ResolveWeekNavigationOptions {
  /** Raw requested date (YYYY-MM-DD expected), in display timezone. */
  requestedDate: string;
  /** Fallback local date (today key), used when requestedDate is invalid. */
  fallbackDate: string;
  /** Snapshot window bounds (UTC ISO). */
  windowStartUtc: string;
  windowEndUtc: string;
  /** Display timezone. */
  timezone: string;
}

export interface WeekNavigation {
  weekStart: string;
  prevStart: string;
  nextStart: string;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Resolve week navigation safely against the snapshot window.
 *
 * This prevents navigating to weeks completely outside synced coverage,
 * which would otherwise appear "available" simply due to missing data.
 */
export function resolveWeekNavigation(opts: ResolveWeekNavigationOptions): WeekNavigation {
  const fallback = DateTime.fromISO(opts.fallbackDate, { zone: opts.timezone });
  const requested = DateTime.fromISO(opts.requestedDate, { zone: opts.timezone });

  const anchor = requested.isValid ? requested : fallback;
  const fallbackWeek = fallback.isValid ? fallback.startOf("week") : DateTime.now().setZone(opts.timezone).startOf("week");
  let currentWeek = anchor.isValid ? anchor.startOf("week") : fallbackWeek;

  const windowStart = DateTime.fromISO(opts.windowStartUtc, { zone: "utc" }).setZone(opts.timezone);
  const windowEnd = DateTime.fromISO(opts.windowEndUtc, { zone: "utc" }).setZone(opts.timezone);

  if (windowStart.isValid && windowEnd.isValid && windowEnd > windowStart) {
    const minWeek = windowStart.startOf("week");
    const maxWeek = windowEnd.minus({ milliseconds: 1 }).startOf("week");

    if (currentWeek < minWeek) currentWeek = minWeek;
    if (currentWeek > maxWeek) currentWeek = maxWeek;

    const hasPrev = currentWeek > minWeek;
    const hasNext = currentWeek < maxWeek;
    const prevWeek = hasPrev ? currentWeek.minus({ weeks: 1 }) : currentWeek;
    const nextWeek = hasNext ? currentWeek.plus({ weeks: 1 }) : currentWeek;

    return {
      weekStart: currentWeek.toFormat("yyyy-LL-dd"),
      prevStart: prevWeek.toFormat("yyyy-LL-dd"),
      nextStart: nextWeek.toFormat("yyyy-LL-dd"),
      hasPrev,
      hasNext,
    };
  }

  // Fallback: if window bounds are invalid for any reason, keep navigation functional.
  return {
    weekStart: currentWeek.toFormat("yyyy-LL-dd"),
    prevStart: currentWeek.minus({ weeks: 1 }).toFormat("yyyy-LL-dd"),
    nextStart: currentWeek.plus({ weeks: 1 }).toFormat("yyyy-LL-dd"),
    hasPrev: true,
    hasNext: true,
  };
}

export interface ResolveMonthNavigationOptions {
  /** Raw requested month key (YYYY-MM expected), in display timezone. */
  requestedMonth: string;
  /** Fallback local date (today key), used when requestedMonth is invalid. */
  fallbackDate: string;
  /** Snapshot window bounds (UTC ISO). */
  windowStartUtc: string;
  windowEndUtc: string;
  /** Display timezone. */
  timezone: string;
}

export interface MonthNavigation {
  monthKey: string;
  prevMonth: string;
  nextMonth: string;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Resolve month navigation safely against the snapshot window.
 */
export function resolveMonthNavigation(opts: ResolveMonthNavigationOptions): MonthNavigation {
  const fallback = DateTime.fromISO(opts.fallbackDate, { zone: opts.timezone });
  const requested = DateTime.fromFormat(opts.requestedMonth, "yyyy-LL", { zone: opts.timezone });

  const fallbackMonth = fallback.isValid
    ? fallback.startOf("month")
    : DateTime.now().setZone(opts.timezone).startOf("month");
  let currentMonth = requested.isValid ? requested.startOf("month") : fallbackMonth;

  const windowStart = DateTime.fromISO(opts.windowStartUtc, { zone: "utc" }).setZone(opts.timezone);
  const windowEnd = DateTime.fromISO(opts.windowEndUtc, { zone: "utc" }).setZone(opts.timezone);

  if (windowStart.isValid && windowEnd.isValid && windowEnd > windowStart) {
    const minMonth = windowStart.startOf("month");
    const maxMonth = windowEnd.minus({ milliseconds: 1 }).startOf("month");

    if (currentMonth < minMonth) currentMonth = minMonth;
    if (currentMonth > maxMonth) currentMonth = maxMonth;

    const hasPrev = currentMonth > minMonth;
    const hasNext = currentMonth < maxMonth;
    const prevMonth = hasPrev ? currentMonth.minus({ months: 1 }) : currentMonth;
    const nextMonth = hasNext ? currentMonth.plus({ months: 1 }) : currentMonth;

    return {
      monthKey: currentMonth.toFormat("yyyy-LL"),
      prevMonth: prevMonth.toFormat("yyyy-LL"),
      nextMonth: nextMonth.toFormat("yyyy-LL"),
      hasPrev,
      hasNext,
    };
  }

  return {
    monthKey: currentMonth.toFormat("yyyy-LL"),
    prevMonth: currentMonth.minus({ months: 1 }).toFormat("yyyy-LL"),
    nextMonth: currentMonth.plus({ months: 1 }).toFormat("yyyy-LL"),
    hasPrev: true,
    hasNext: true,
  };
}

export interface MonthDayStatus {
  /** YYYY-MM-DD in display timezone. */
  date: string;
  dayOfMonth: number;
  status: DayStatus["status"];
  isToday: boolean;
  isWeekend: boolean;
  isCurrentMonth: boolean;
}

export interface MonthWeek {
  days: MonthDayStatus[];
}

export interface MonthBoardData {
  monthKey: string;
  label: string;
  weeks: MonthWeek[];
}

export interface BuildMonthBoardOptions {
  snapshot: Snapshot;
  /** Month key in display timezone, YYYY-MM. */
  month: string;
  /** IANA timezone to render in. Falls back to snapshot.config.timezone. */
  timezone?: string;
  /** Now, for highlighting today. */
  nowMs?: number;
}

/**
 * Build a month-grid board with one status per day:
 * booked if ANY blocker event overlaps that local calendar day.
 */
export function buildMonthBoard(opts: BuildMonthBoardOptions): MonthBoardData {
  const tz = opts.timezone ?? opts.snapshot.config.timezone;
  const nowMs = opts.nowMs ?? Date.now();
  const todayKey = todayInZone(tz, nowMs);

  const monthStart = DateTime.fromFormat(opts.month, "yyyy-LL", { zone: tz }).startOf("month");
  if (!monthStart.isValid) {
    throw new Error(`Invalid month "${opts.month}" for zone ${tz}`);
  }
  const monthEnd = monthStart.plus({ months: 1 });

  const gridStart = monthStart.startOf("week");
  const gridEnd = monthEnd.minus({ days: 1 }).endOf("week").startOf("day");

  const busy: Interval[] = opts.snapshot.busy
    .map((b) => ({
      startMs: Date.parse(b.startUtc),
      endMs: Date.parse(b.endUtc),
      tentative: b.tentative,
    }))
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const days: MonthDayStatus[] = [];
  let day = gridStart;
  while (day <= gridEnd) {
    const dayStartMs = day.startOf("day").toUTC().toMillis();
    const dayEndMs = day.plus({ days: 1 }).startOf("day").toUTC().toMillis();
    const dateKey = day.toFormat("yyyy-LL-dd");
    const status: DayStatus["status"] = overlapsAny({ startMs: dayStartMs, endMs: dayEndMs }, busy)
      ? "booked"
      : "available";

    days.push({
      date: dateKey,
      dayOfMonth: day.day,
      status,
      isToday: dateKey === todayKey,
      isWeekend: day.weekday === 6 || day.weekday === 7,
      isCurrentMonth: day.month === monthStart.month && day.year === monthStart.year,
    });

    day = day.plus({ days: 1 });
  }

  const weeks: MonthWeek[] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push({ days: days.slice(i, i + 7) });
  }

  return {
    monthKey: monthStart.toFormat("yyyy-LL"),
    label: monthStart.toFormat("LLLL yyyy"),
    weeks,
  };
}

/**
 * Build one DayStatus per weekday (Mon–Fri), grouped by week.
 *
 * Rule: if ANY busy block in the snapshot overlaps this weekday's
 * workday window, the day is "booked". Otherwise "available".
 *
 * Conservative: tentative blocks are treated as booked. All-day and
 * multi-day events are handled automatically because they appear as
 * busy intervals that span the whole working window.
 */
export function buildDayBoard(opts: BuildDayBoardOptions): WeekGroup[] {
  const tz = opts.timezone ?? opts.snapshot.config.timezone;
  const nowMs = opts.nowMs ?? Date.now();
  const todayKey = todayInZone(tz, nowMs);

  // Anchor to the Monday of startDate in display tz.
  const anchor = DateTime.fromISO(opts.startDate, { zone: tz });
  if (!anchor.isValid) {
    throw new Error(`Invalid startDate "${opts.startDate}" for zone ${tz}`);
  }
  const mondayKey = anchor.startOf("week").toFormat("yyyy-LL-dd"); // Luxon: Monday

  // Build 7 days × weeks, then keep only weekdays.
  const totalDays = 7 * opts.weeks;
  const windows = buildWorkdayWindows(
    mondayKey,
    totalDays,
    opts.workdayStartHour,
    opts.workdayEndHour,
    tz,
  );

  const busy: Interval[] = opts.snapshot.busy
    .map((b) => ({
      startMs: Date.parse(b.startUtc),
      endMs: Date.parse(b.endUtc),
      tentative: b.tentative,
    }))
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const groups: WeekGroup[] = [];
  for (let wk = 0; wk < opts.weeks; wk++) {
    const weekWindows = windows.slice(wk * 7, wk * 7 + 7).filter((w) => !w.isWeekend);
    const days: DayStatus[] = weekWindows.map((w) => {
      const overlapping = overlapsAny(w.frame, busy);
      // Conservative: any overlap (including tentative) → booked.
      const status: DayStatus["status"] = overlapping ? "booked" : "available";
      return {
        date: w.dateKey,
        label: formatDayLabel(w.dateKey, tz),
        isToday: w.dateKey === todayKey,
        status,
      };
    });

    const firstDate = weekWindows[0]?.dateKey ?? mondayKey;
    groups.push({
      weekOf: firstDate,
      label: formatWeekLabel(firstDate, tz),
      days,
    });
  }

  return groups;
}

function formatDayLabel(isoDate: string, timezone: string): string {
  // e.g. "Monday, Apr 21"
  return DateTime.fromISO(isoDate, { zone: timezone }).toFormat("cccc, LLL d");
}

function formatWeekLabel(isoDate: string, timezone: string): string {
  return `Week of ${DateTime.fromISO(isoDate, { zone: timezone }).toFormat("LLL d")}`;
}
