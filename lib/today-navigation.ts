/**
 * Pure helpers for board navigation targets and the Today button.
 *
 * Extracted as a separate module so the navigation logic can be unit
 * tested without spinning up React.
 */

import { DateTime } from "luxon";

export interface TodayClickTarget {
  viewMode: "list" | "month";
  weekStart: string;
  monthKey: string;
}

export function isTodayClickTarget(
  target: TodayClickTarget,
  sourceTodayKey: string,
  sourceTodayMonthKey: string,
): boolean {
  if (target.viewMode === "list" && target.weekStart === sourceTodayKey) return true;
  if (target.viewMode === "month" && target.monthKey === sourceTodayMonthKey) return true;
  return false;
}

/**
 * The current date (`yyyy-LL-dd`) in `timezone`, derived from the browser's
 * clock. Never read from a payload's `todayKey` — that value is frozen at
 * whatever moment the payload was generated (server render or cache write)
 * and goes stale across a day boundary.
 */
export function computeTodayKeyForZone(timezone: string, nowMs: number = Date.now()): string {
  return DateTime.fromMillis(nowMs, { zone: "utc" }).setZone(timezone).toFormat("yyyy-LL-dd");
}

/**
 * Milliseconds until the next local-midnight boundary in `timezone`, so a
 * caller can schedule a single timer that fires exactly when "today"
 * changes rather than polling.
 */
export function msUntilNextLocalMidnight(timezone: string, nowMs: number = Date.now()): number {
  const now = DateTime.fromMillis(nowMs, { zone: "utc" }).setZone(timezone);
  if (!now.isValid) return 0;
  const nextMidnight = now.plus({ days: 1 }).startOf("day");
  return Math.max(nextMidnight.toMillis() - nowMs, 0);
}

/**
 * Whether the currently displayed week/month is the one that WAS "today"
 * before a day-boundary rollover — i.e. the user was naturally viewing
 * "today" rather than having intentionally navigated elsewhere. Used to
 * decide whether the route target should follow forward to the new today
 * when the app resumes (or stays open) across midnight, without yanking a
 * user who deliberately opened a different week/month/date.
 */
export function shouldFollowRouteTargetToNewToday(opts: {
  viewMode: "list" | "month";
  routeTargetWeekStart: string;
  routeTargetMonthKey: string;
  previousTodayKey: string;
  timezone: string;
}): boolean {
  if (opts.viewMode === "list") {
    const previousTodayWeekStart = normalizeWeekStartForCacheLookup({
      weekStart: opts.previousTodayKey,
      timezone: opts.timezone,
    });
    return opts.routeTargetWeekStart === previousTodayWeekStart;
  }
  return opts.routeTargetMonthKey === opts.previousTodayKey.slice(0, 7);
}

/**
 * Resolve the week-start (`yyyy-LL-dd`, Monday) to render for the main
 * page's `?start=` search param. Falls back to today's week whenever the
 * param is absent or fails the strict date-shape check, so a normal visit
 * (no param) always resolves to the current local week.
 */
export function resolveRequestedWeekStart(opts: {
  requestedWeekParam: string | undefined;
  todayKey: string;
  timezone: string;
}): string {
  const trimmed = opts.requestedWeekParam?.trim();
  const requestedWeek = trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : opts.todayKey;
  const weekStartDt = DateTime.fromISO(requestedWeek, { zone: opts.timezone });
  return weekStartDt.isValid ? weekStartDt.startOf("week").toFormat("yyyy-LL-dd") : opts.todayKey;
}

/**
 * Resolve the month (`yyyy-LL`) to render for the main page's `?month=`
 * search param. Falls back to today's month whenever the param is absent
 * or fails the strict shape check.
 */
export function resolveRequestedMonthKey(opts: {
  requestedMonthParam: string | undefined;
  todayMonthKey: string;
}): string {
  const trimmed = opts.requestedMonthParam?.trim();
  return trimmed && /^\d{4}-\d{2}$/.test(trimmed) ? trimmed : opts.todayMonthKey;
}

/**
 * Normalize a List/Week navigation target's `weekStart` to its week's
 * Monday so it can be looked up against `weekWindow.weeks` (which is
 * keyed by Monday).
 *
 * Why: the Today button's href uses today's calendar date — e.g., a
 * Tuesday `2026-05-12` — but the cached weekWindow indexes weeks by
 * the Monday they start on (`2026-05-11`). Without normalization the
 * client-side derive lookup would miss and Today would fall through to
 * `router.push`, which can be silently short-circuited by Next.js when
 * window.history was advanced by earlier prev/next pushStateHref
 * clicks.
 *
 * Invalid input is returned unchanged so the caller's downstream
 * lookup misses gracefully and falls back to `router.push` instead of
 * crashing.
 */
export function normalizeWeekStartForCacheLookup(opts: {
  weekStart: string;
  timezone: string;
}): string {
  const dt = DateTime.fromISO(opts.weekStart, { zone: opts.timezone });
  if (!dt.isValid) return opts.weekStart;
  return dt.startOf("week").toFormat("yyyy-LL-dd");
}

export function deriveMonthKeyFromFocusedDate(opts: {
  focusedDate: string | null;
  timezone: string;
  fallbackMonthKey: string;
}): string {
  if (!opts.focusedDate) return opts.fallbackMonthKey;
  const dt = DateTime.fromISO(opts.focusedDate, { zone: opts.timezone });
  if (!dt.isValid) return opts.fallbackMonthKey;
  return dt.toFormat("yyyy-LL");
}

export function deriveListStartFromFocusedDate(opts: {
  focusedDate: string | null;
  fallbackStartDate: string;
}): string {
  if (!opts.focusedDate) return opts.fallbackStartDate;
  const dt = DateTime.fromISO(opts.focusedDate, { zone: "utc" });
  if (!dt.isValid) return opts.fallbackStartDate;
  return dt.toFormat("yyyy-LL-dd");
}

export function deriveWeekAnchorDateForMonth(opts: {
  monthKey: string;
  timezone: string;
  preferredDate?: string | null;
  todayKey?: string;
}): string {
  const monthStart = DateTime.fromFormat(opts.monthKey, "yyyy-LL", { zone: opts.timezone })
    .startOf("month");
  if (!monthStart.isValid) {
    return `${opts.monthKey}-01`;
  }

  const preferredDate = opts.preferredDate
    ? DateTime.fromISO(opts.preferredDate, { zone: opts.timezone })
    : null;
  if (
    preferredDate?.isValid
    && preferredDate.toFormat("yyyy-LL") === opts.monthKey
  ) {
    return preferredDate.toFormat("yyyy-LL-dd");
  }

  const today = opts.todayKey
    ? DateTime.fromISO(opts.todayKey, { zone: opts.timezone })
    : null;
  if (today?.isValid && today.toFormat("yyyy-LL") === opts.monthKey) {
    return today.toFormat("yyyy-LL-dd");
  }

  for (let i = 0; i < 7; i += 1) {
    const candidate = monthStart.plus({ days: i });
    if (candidate.startOf("week").toFormat("yyyy-LL") === opts.monthKey) {
      return candidate.toFormat("yyyy-LL-dd");
    }
  }

  return monthStart.toFormat("yyyy-LL-dd");
}

export function deriveFocusedDateForMonthKey(opts: {
  monthKey: string;
  timezone: string;
  fallbackDate: string;
  dayOfMonth?: number;
}): string {
  const monthStart = DateTime.fromFormat(opts.monthKey, "yyyy-LL", { zone: opts.timezone }).startOf("month");
  if (!monthStart.isValid) return opts.fallbackDate;
  const day = Math.max(1, Math.min(opts.dayOfMonth ?? 1, monthStart.daysInMonth));
  return monthStart.set({ day }).toFormat("yyyy-LL-dd");
}

export function deriveFocusedDateForWeekTarget(opts: {
  focusedDate: string | null;
  targetWeekStart: string;
  sourceWeekStart: string;
  timezone: string;
}): string {
  const targetWeek = DateTime.fromISO(opts.targetWeekStart, { zone: opts.timezone }).startOf("week");
  const sourceWeek = DateTime.fromISO(opts.sourceWeekStart, { zone: opts.timezone }).startOf("week");
  const focused = opts.focusedDate
    ? DateTime.fromISO(opts.focusedDate, { zone: opts.timezone })
    : null;

  if (!targetWeek.isValid) return opts.targetWeekStart;
  if (!sourceWeek.isValid || !focused?.isValid) {
    return targetWeek.toFormat("yyyy-LL-dd");
  }

  const diffDays = Math.round(targetWeek.diff(sourceWeek, "days").days);
  if (!Number.isFinite(diffDays)) {
    return targetWeek.toFormat("yyyy-LL-dd");
  }
  return focused.plus({ days: diffDays }).toFormat("yyyy-LL-dd");
}
