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
