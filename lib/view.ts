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

import type {
  CalendarDisplayMode,
  DayEventDetail,
  DayStatus,
  DayView,
  DaySlot,
  RenderState,
  Snapshot,
  SnapshotStatus,
} from "./types";
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
  /** Explicit "today" key (YYYY-MM-DD), if already computed upstream. */
  todayKey?: string;
}

export interface WeekGroup {
  /** Monday of the week, YYYY-MM-DD. */
  weekOf: string;
  /** Human label, e.g. "Week of Apr 21". */
  label: string;
  days: DayStatus[];
}

export interface TrimWeekRowsForScheduleListOptions {
  weeks: WeekGroup[];
  selectedWeekStart: string;
  currentWeekStart: string;
  todayKey: string;
}

/**
 * Keep future weeks full-length, but hide already-past rows for the current week.
 */
export function trimWeekRowsForScheduleList(
  opts: TrimWeekRowsForScheduleListOptions,
): WeekGroup[] {
  const { weeks, selectedWeekStart, currentWeekStart, todayKey } = opts;
  if (weeks.length === 0) return weeks;
  if (selectedWeekStart !== currentWeekStart) return weeks;

  const [firstWeek, ...restWeeks] = weeks;
  if (!firstWeek) return weeks;

  const visibleDays = firstWeek.days.filter((day) => day.date >= todayKey);
  if (visibleDays.length === 0 || visibleDays.length === firstWeek.days.length) {
    return weeks;
  }

  return [
    {
      ...firstWeek,
      days: visibleDays,
    },
    ...restWeeks,
  ];
}

interface NamedEventInterval extends Interval {
  summary: string;
  calendarId?: string;
  displayMode: CalendarDisplayMode;
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
  eventNames: string[];
  eventDetails?: DayEventDetail[];
  bookedDisplay?: "details" | "private" | "mixed";
}

export interface MonthEventBarDetail {
  summary: string;
  jobNumber?: string;
  dateRangeLabel?: string;
  timeRangeLabel?: string;
  displayMode?: CalendarDisplayMode;
}

export interface MonthEventBar {
  key: string;
  identity: string;
  startDayIndex: number;
  endDayIndex: number;
  laneIndex: number;
  segmentStartDate: string;
  segmentEndDate: string;
  label: string;
  title?: string;
  jobNumber?: string;
  isPrivateUnavailable: boolean;
  details: MonthEventBarDetail[];
}

export interface MonthWeek {
  days: MonthDayStatus[];
  bars: MonthEventBar[];
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
  /** Explicit "today" key (YYYY-MM-DD), if already computed upstream. */
  todayKey?: string;
}

export type DayConnectorPart = "none" | "start" | "middle" | "end";

function normalizeEventName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function snapshotNamedEvents(snapshot: Snapshot): NamedEventInterval[] {
  return (snapshot.namedEvents ?? [])
    .map((event) => ({
      startMs: Date.parse(event.startUtc),
      endMs: Date.parse(event.endUtc),
      summary: normalizeEventName(event.summary),
      calendarId: event.calendarId,
      displayMode: event.displayMode ?? "details",
    }))
    .filter(
      (event) => Number.isFinite(event.startMs)
        && Number.isFinite(event.endMs)
        && event.endMs > event.startMs
        && event.summary.length > 0,
    )
    .sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      if (a.endMs !== b.endMs) return a.endMs - b.endMs;
      return a.summary.localeCompare(b.summary);
    });
}

function isMidnight(dt: DateTime): boolean {
  return dt.hour === 0 && dt.minute === 0 && dt.second === 0 && dt.millisecond === 0;
}

function formatEventDateRange(
  startMs: number,
  endMs: number,
  timezone: string,
  referenceYear: number,
): string {
  const start = DateTime.fromMillis(startMs, { zone: "utc" }).setZone(timezone);
  const end = DateTime.fromMillis(endMs, { zone: "utc" }).setZone(timezone);

  let displayEnd = end;
  if (isMidnight(end) && end > start) {
    // Date-only all-day events are end-exclusive in Google responses.
    displayEnd = end.minus({ days: 1 });
  }
  if (displayEnd < start) displayEnd = start;

  const sameDay = start.hasSame(displayEnd, "day");
  const sameYear = start.year === displayEnd.year;
  const includeYear = !sameYear || start.year !== referenceYear || displayEnd.year !== referenceYear;

  if (sameDay) {
    return includeYear ? start.toFormat("LLL d, yyyy") : start.toFormat("LLL d");
  }
  if (!includeYear) {
    return `${start.toFormat("LLL d")} – ${displayEnd.toFormat("LLL d")}`;
  }
  if (sameYear) {
    return `${start.toFormat("LLL d")} – ${displayEnd.toFormat("LLL d, yyyy")}`;
  }
  return `${start.toFormat("LLL d, yyyy")} – ${displayEnd.toFormat("LLL d, yyyy")}`;
}

function formatEventTimeRange(startMs: number, endMs: number, timezone: string): string | undefined {
  const start = DateTime.fromMillis(startMs, { zone: "utc" }).setZone(timezone);
  const end = DateTime.fromMillis(endMs, { zone: "utc" }).setZone(timezone);
  const hasSpecificTime = !(isMidnight(start) && isMidnight(end));
  if (!hasSpecificTime) return undefined;

  const sameDay = start.toFormat("yyyy-LL-dd") === end.toFormat("yyyy-LL-dd");
  if (sameDay) {
    return `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`;
  }
  return `${start.toFormat("LLL d h:mm a")} – ${end.toFormat("LLL d h:mm a")}`;
}

function collectEventDetails(
  frame: Interval,
  events: NamedEventInterval[],
  timezone: string,
  referenceYear: number,
): DayEventDetail[] {
  const out: DayEventDetail[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.endMs <= frame.startMs) continue;
    if (event.startMs >= frame.endMs) break;
    if (event.startMs < frame.endMs && event.endMs > frame.startMs) {
      const safeSummary = event.displayMode === "private" ? "Unavailable" : event.summary;
      const key = `${safeSummary}|${event.startMs}|${event.endMs}|${event.displayMode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const timeRangeLabel = formatEventTimeRange(event.startMs, event.endMs, timezone);
      out.push({
        summary: safeSummary,
        startUtc: new Date(event.startMs).toISOString(),
        endUtc: new Date(event.endMs).toISOString(),
        dateRangeLabel: formatEventDateRange(event.startMs, event.endMs, timezone, referenceYear),
        ...(timeRangeLabel ? { timeRangeLabel } : {}),
        ...(event.calendarId ? { calendarId: event.calendarId } : {}),
        displayMode: event.displayMode,
      });
    }
  }

  return out;
}

function resolveBookedDisplay(details: DayEventDetail[]): "details" | "private" | "mixed" | undefined {
  if (details.length === 0) return undefined;

  let hasPrivate = false;
  let hasDetails = false;
  for (const detail of details) {
    if ((detail.displayMode ?? "details") === "private") hasPrivate = true;
    else hasDetails = true;
  }
  if (hasPrivate && hasDetails) return "mixed";
  return hasPrivate ? "private" : "details";
}

function extractLaJobNumber(summary: string): string | null {
  const match = summary.match(/\bLA\s*#?\s*(\d{3,})\b/i);
  if (!match) return null;
  return `LA#${match[1]}`;
}

function truncateLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

export function summarizeBookedDayLabel(
  eventNames?: string[],
  eventDetails?: DayEventDetail[],
  bookedDisplay?: "details" | "private" | "mixed",
): {
  label: string;
  title?: string;
  jobNumber?: string;
  isPrivateUnavailable?: boolean;
  details: Array<{
    summary: string;
    jobNumber?: string;
    dateRangeLabel?: string;
    timeRangeLabel?: string;
    displayMode?: CalendarDisplayMode;
  }>;
} {
  const normalizedDetails: DayEventDetail[] = [];
  const seenDetails = new Set<string>();
  for (const detail of eventDetails ?? []) {
    const detailMode = detail.displayMode ?? "details";
    const summary = detailMode === "private"
      ? "Unavailable"
      : normalizeEventName(detail.summary);
    if (summary.length === 0) continue;
    const key = `${summary}|${detail.startUtc}|${detail.endUtc}|${detailMode}`;
    if (seenDetails.has(key)) continue;
    seenDetails.add(key);
    normalizedDetails.push({
      ...detail,
      summary,
      displayMode: detailMode,
    });
  }

  const effectiveDisplay = bookedDisplay ?? resolveBookedDisplay(normalizedDetails);
  if (effectiveDisplay === "private") {
    const privateDetails = (normalizedDetails.length > 0
      ? normalizedDetails
      : []).map((detail) => ({
      summary: "Unavailable",
      ...(detail.dateRangeLabel ? { dateRangeLabel: detail.dateRangeLabel } : {}),
      ...(detail.timeRangeLabel ? { timeRangeLabel: detail.timeRangeLabel } : {}),
      displayMode: "private" as const,
    }));
    return {
      label: "Unavailable",
      title: "Unavailable",
      isPrivateUnavailable: true,
      details: privateDetails.length > 0
        ? privateDetails
        : [{ summary: "Unavailable", displayMode: "private" }],
    };
  }

  const names = (normalizedDetails.length > 0
    ? normalizedDetails.map((detail) => detail.summary)
    : (eventNames ?? []))
    .map(normalizeEventName)
    .filter((name) => name.length > 0);
  if (names.length === 0) return { label: "Busy", details: [] };

  const deduped: string[] = [];
  const seenNames = new Set<string>();
  for (const name of names) {
    if (!seenNames.has(name)) {
      seenNames.add(name);
      deduped.push(name);
    }
  }

  const title = deduped.join(" • ");
  const jobNumbers: string[] = [];
  const seenJobs = new Set<string>();
  for (const name of deduped) {
    const job = extractLaJobNumber(name);
    if (job && !seenJobs.has(job)) {
      seenJobs.add(job);
      jobNumbers.push(job);
    }
  }

  if (jobNumbers.length > 0) {
    const more = jobNumbers.length - 1;
    const firstJob = jobNumbers[0] as string;
    return {
      label: more > 0 ? `${firstJob} +${more} more` : firstJob,
      title,
      jobNumber: firstJob,
      details: (normalizedDetails.length > 0
        ? normalizedDetails.map((detail) => {
          const detailJob = extractLaJobNumber(detail.summary) ?? undefined;
          return {
            summary: detail.summary,
            ...(detailJob ? { jobNumber: detailJob } : {}),
            dateRangeLabel: detail.dateRangeLabel,
            ...(detail.timeRangeLabel ? { timeRangeLabel: detail.timeRangeLabel } : {}),
            displayMode: detail.displayMode ?? "details",
          };
        })
        : deduped.map((summary) => {
          const detailJob = extractLaJobNumber(summary) ?? undefined;
          return {
            summary,
            ...(detailJob ? { jobNumber: detailJob } : {}),
            displayMode: "details" as const,
          };
        })),
    };
  }

  const nonGeneric = deduped.filter((name) => !/^busy$/i.test(name));
  const source = nonGeneric.length > 0 ? nonGeneric : deduped;
  const first = truncateLabel(source[0] as string, 28);
  const more = source.length - 1;
  return {
    label: more > 0 ? `${first} +${more} more` : first,
    title,
    details: (normalizedDetails.length > 0
      ? normalizedDetails.map((detail) => ({
        summary: detail.summary,
        dateRangeLabel: detail.dateRangeLabel,
        ...(detail.timeRangeLabel ? { timeRangeLabel: detail.timeRangeLabel } : {}),
        displayMode: detail.displayMode ?? "details",
      }))
      : source.map((summary) => ({ summary, displayMode: "details" as const }))),
  };
}

interface BuildMonthEventBarsOptions {
  days: MonthDayStatus[];
  events: NamedEventInterval[];
  timezone: string;
  referenceYear: number;
  gridStart: DateTime;
  gridEnd: DateTime;
}

interface MonthEventBarDraft {
  key: string;
  identity: string;
  startDayIndex: number;
  endDayIndex: number;
  segmentStartDate: string;
  segmentEndDate: string;
  label: string;
  title?: string;
  jobNumber?: string;
  isPrivateUnavailable: boolean;
  details: MonthEventBarDetail[];
}

function buildMonthEventBars(opts: BuildMonthEventBarsOptions): MonthEventBar[][] {
  const weekCount = Math.ceil(opts.days.length / 7);
  const barsByWeek: MonthEventBarDraft[][] = Array.from({ length: weekCount }, () => []);
  const dateToPosition = new Map<string, { weekIndex: number; dayIndex: number }>();
  opts.days.forEach((day, index) => {
    dateToPosition.set(day.date, {
      weekIndex: Math.floor(index / 7),
      dayIndex: index % 7,
    });
  });

  const seenIdentities = new Set<string>();

  for (const event of opts.events) {
    const safeSummary = event.displayMode === "private" ? "Unavailable" : event.summary;
    const eventStartUtc = new Date(event.startMs).toISOString();
    const eventEndUtc = new Date(event.endMs).toISOString();
    const identity = `${safeSummary}|${eventStartUtc}|${eventEndUtc}|${event.calendarId ?? ""}|${event.displayMode}`;
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);

    const localStart = DateTime.fromMillis(event.startMs, { zone: "utc" }).setZone(opts.timezone);
    const localEndRaw = DateTime.fromMillis(event.endMs, { zone: "utc" }).setZone(opts.timezone);
    let localEnd = localEndRaw;
    if (isMidnight(localEndRaw) && localEndRaw > localStart) {
      localEnd = localEndRaw.minus({ days: 1 });
    }
    if (localEnd < localStart) localEnd = localStart;

    const eventStartDay = localStart.startOf("day");
    const eventEndDay = localEnd.startOf("day");
    const clippedStart = eventStartDay < opts.gridStart ? opts.gridStart : eventStartDay;
    const clippedEnd = eventEndDay > opts.gridEnd ? opts.gridEnd : eventEndDay;
    if (clippedStart > clippedEnd) continue;

    const timeRangeLabel = formatEventTimeRange(event.startMs, event.endMs, opts.timezone);
    const detail: DayEventDetail = {
      summary: safeSummary,
      startUtc: eventStartUtc,
      endUtc: eventEndUtc,
      dateRangeLabel: formatEventDateRange(event.startMs, event.endMs, opts.timezone, opts.referenceYear),
      ...(timeRangeLabel ? { timeRangeLabel } : {}),
      ...(event.calendarId ? { calendarId: event.calendarId } : {}),
      displayMode: event.displayMode,
    };
    const bookedDisplay: "details" | "private" = event.displayMode === "private" ? "private" : "details";
    const labelMeta = summarizeBookedDayLabel([safeSummary], [detail], bookedDisplay);

    let cursor = clippedStart;
    while (cursor <= clippedEnd) {
      const segmentWeekStart = cursor.startOf("week");
      const segmentEndCap = segmentWeekStart.plus({ days: 6 });
      const segmentEnd = segmentEndCap < clippedEnd ? segmentEndCap : clippedEnd;
      const segmentStartDate = cursor.toFormat("yyyy-LL-dd");
      const segmentEndDate = segmentEnd.toFormat("yyyy-LL-dd");
      const startPos = dateToPosition.get(segmentStartDate);
      const endPos = dateToPosition.get(segmentEndDate);
      if (!startPos || !endPos || startPos.weekIndex !== endPos.weekIndex) break;

      barsByWeek[startPos.weekIndex]?.push({
        key: `${identity}|${segmentStartDate}|${segmentEndDate}`,
        identity,
        startDayIndex: startPos.dayIndex,
        endDayIndex: endPos.dayIndex,
        segmentStartDate,
        segmentEndDate,
        label: labelMeta.label,
        ...(labelMeta.title ? { title: labelMeta.title } : {}),
        ...(labelMeta.jobNumber ? { jobNumber: labelMeta.jobNumber } : {}),
        isPrivateUnavailable: labelMeta.isPrivateUnavailable === true,
        details: labelMeta.details.map((row) => ({
          summary: row.summary,
          ...(row.jobNumber ? { jobNumber: row.jobNumber } : {}),
          ...(row.dateRangeLabel ? { dateRangeLabel: row.dateRangeLabel } : {}),
          ...(row.timeRangeLabel ? { timeRangeLabel: row.timeRangeLabel } : {}),
          displayMode: row.displayMode,
        })),
      });

      cursor = segmentEnd.plus({ days: 1 });
    }
  }

  return barsByWeek.map((weekBars) => {
    const sorted = [...weekBars].sort((a, b) => {
      if (a.startDayIndex !== b.startDayIndex) return a.startDayIndex - b.startDayIndex;
      if (a.endDayIndex !== b.endDayIndex) return b.endDayIndex - a.endDayIndex;
      return a.key.localeCompare(b.key);
    });
    const laneEnds: number[] = [];
    return sorted.map((bar) => {
      let laneIndex = laneEnds.findIndex((end) => bar.startDayIndex > end);
      if (laneIndex === -1) laneIndex = laneEnds.length;
      laneEnds[laneIndex] = bar.endDayIndex;
      return {
        ...bar,
        laneIndex,
      };
    });
  });
}

export function connectorKeyForDay(day: DayStatus): string | null {
  if (day.status !== "booked") return null;
  if (day.bookedDisplay === "private") return null;

  const details = (day.eventDetails ?? []).filter((detail) => (detail.displayMode ?? "details") !== "private");
  if (details.length === 0) return null;

  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const detail of details) {
    const summary = normalizeEventName(detail.summary);
    if (summary.length === 0 || /^unavailable$/i.test(summary)) continue;

    const startMs = Date.parse(detail.startUtc);
    const endMs = Date.parse(detail.endUtc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    const token = `${summary}|${detail.startUtc}|${detail.endUtc}|${detail.calendarId ?? ""}`;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  if (tokens.length === 0) return null;
  tokens.sort();
  return tokens.join("||");
}

function connectorPartForIndex(
  keys: Array<string | null>,
  index: number,
): DayConnectorPart {
  const key = keys[index];
  if (!key) return "none";

  const prevSame = index > 0 && keys[index - 1] === key;
  const nextSame = index + 1 < keys.length && keys[index + 1] === key;

  if (prevSame && nextSame) return "middle";
  if (!prevSame && nextSame) return "start";
  if (prevSame && !nextSame) return "end";
  return "none";
}

export function buildWeekConnectorParts(
  connectorKeysByWeek: Array<Array<string | null>>,
): Array<Array<DayConnectorPart>> {
  return connectorKeysByWeek.map((keys) => keys.map((_, idx) => connectorPartForIndex(keys, idx)));
}

/**
 * Build a month-grid board with one status per day:
 * booked if ANY blocker event overlaps that local calendar day.
 */
export function buildMonthBoard(opts: BuildMonthBoardOptions): MonthBoardData {
  const tz = opts.timezone ?? opts.snapshot.config.timezone;
  const nowMs = opts.nowMs ?? Date.now();
  const todayKey = opts.todayKey ?? todayInZone(tz, nowMs);
  const referenceYear = Number.parseInt(todayKey.slice(0, 4), 10)
    || DateTime.fromMillis(nowMs, { zone: tz }).year;

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
  const namedEvents = snapshotNamedEvents(opts.snapshot);

  const days: MonthDayStatus[] = [];
  let day = gridStart;
  while (day <= gridEnd) {
    const dayStartMs = day.startOf("day").toUTC().toMillis();
    const dayEndMs = day.plus({ days: 1 }).startOf("day").toUTC().toMillis();
    const dateKey = day.toFormat("yyyy-LL-dd");
    const frame = { startMs: dayStartMs, endMs: dayEndMs };
    const status: DayStatus["status"] = overlapsAny(frame, busy)
      ? "booked"
      : "available";
    const eventDetails = status === "booked"
      ? collectEventDetails(frame, namedEvents, tz, referenceYear)
      : [];
    const eventNames = status === "booked"
      ? [...new Set(eventDetails.map((detail) => detail.summary))]
      : [];
    const bookedDisplay = status === "booked" ? resolveBookedDisplay(eventDetails) : undefined;

    days.push({
      date: dateKey,
      dayOfMonth: day.day,
      status,
      isToday: dateKey === todayKey,
      isWeekend: day.weekday === 6 || day.weekday === 7,
      isCurrentMonth: day.month === monthStart.month && day.year === monthStart.year,
      eventNames,
      ...(eventDetails.length > 0 ? { eventDetails } : {}),
      ...(bookedDisplay ? { bookedDisplay } : {}),
    });

    day = day.plus({ days: 1 });
  }

  const barsByWeek = buildMonthEventBars({
    days,
    events: namedEvents,
    timezone: tz,
    referenceYear,
    gridStart,
    gridEnd,
  });

  const weeks: MonthWeek[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const weekIndex = Math.floor(i / 7);
    weeks.push({
      days: days.slice(i, i + 7),
      bars: barsByWeek[weekIndex] ?? [],
    });
  }

  return {
    monthKey: monthStart.toFormat("yyyy-LL"),
    label: monthStart.toFormat("LLLL yyyy"),
    weeks,
  };
}

/**
 * Build one DayStatus per calendar day (Mon–Sun), grouped by week.
 *
 * Rule: if ANY busy block in the snapshot overlaps this day's
 * workday window, the day is "booked". Otherwise "available".
 *
 * Conservative: tentative blocks are treated as booked. All-day and
 * multi-day events are handled automatically because they appear as
 * busy intervals that span the whole working window.
 */
export function buildDayBoard(opts: BuildDayBoardOptions): WeekGroup[] {
  const tz = opts.timezone ?? opts.snapshot.config.timezone;
  const nowMs = opts.nowMs ?? Date.now();
  const todayKey = opts.todayKey ?? todayInZone(tz, nowMs);
  const referenceYear = Number.parseInt(todayKey.slice(0, 4), 10)
    || DateTime.fromMillis(nowMs, { zone: tz }).year;

  // Anchor to the Monday of startDate in display tz.
  const anchor = DateTime.fromISO(opts.startDate, { zone: tz });
  if (!anchor.isValid) {
    throw new Error(`Invalid startDate "${opts.startDate}" for zone ${tz}`);
  }
  const mondayKey = anchor.startOf("week").toFormat("yyyy-LL-dd"); // Luxon: Monday

  // Build full calendar weeks (Mon–Sun).
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
  const namedEvents = snapshotNamedEvents(opts.snapshot);

  const groups: WeekGroup[] = [];
  for (let wk = 0; wk < opts.weeks; wk++) {
    const weekWindows = windows.slice(wk * 7, wk * 7 + 7);
    const days: DayStatus[] = weekWindows.map((w) => {
      const overlapping = overlapsAny(w.frame, busy);
      // Conservative: any overlap (including tentative) → booked.
      const status: DayStatus["status"] = overlapping ? "booked" : "available";
      const eventDetails = status === "booked"
        ? collectEventDetails(w.frame, namedEvents, tz, referenceYear)
        : [];
      const eventNames = status === "booked"
        ? [...new Set(eventDetails.map((detail) => detail.summary))]
        : [];
      const bookedDisplay = status === "booked" ? resolveBookedDisplay(eventDetails) : undefined;
      return {
        date: w.dateKey,
        label: formatDayLabel(w.dateKey, tz),
        isToday: w.dateKey === todayKey,
        isWeekend: w.isWeekend,
        status,
        ...(bookedDisplay ? { bookedDisplay } : {}),
        ...(eventNames.length > 0 ? { eventNames } : {}),
        ...(eventDetails.length > 0 ? { eventDetails } : {}),
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
