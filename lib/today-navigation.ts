/**
 * Pure helper for detecting whether a board-navigation target is the
 * user's "Today" jump.
 *
 * Extracted as a separate module so the detection logic can be unit
 * tested without spinning up React. Used by ScheduleView's
 * handleBoardNavigate to short-circuit the cached-derive path and
 * route Today through Next.js's router for full URL+state convergence.
 */

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
