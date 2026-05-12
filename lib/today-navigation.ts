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
