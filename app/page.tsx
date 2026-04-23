import { readCurrentSnapshot } from "@/lib/store";
import {
  classifySnapshot,
  buildDayBoard,
  resolveWeekNavigation,
  buildMonthBoard,
  resolveMonthNavigation,
} from "@/lib/view";
import { todayInZone } from "@/lib/time";
import { getConfig } from "@/lib/config";
import { DayBoard } from "@/components/DayBoard";
import { MonthBoard } from "@/components/MonthBoard";

/**
 * The public availability page.
 *
 * Read-only. Never calls Google at request time. Reads the last known-good
 * snapshot from storage and renders a simple employer-facing board:
 *
 *     Monday, Apr 21     Available
 *     Tuesday, Apr 22    Booked
 *     ...
 *
 * Rules:
 *   - Monday–Friday only. Weekends hidden.
 *   - One status per day: Available or Booked.
 *   - Any overlapping blocker-calendar event (incl. tentative) → Booked.
 *
 * Reliability:
 *   - Fail-closed if snapshot is missing or older than hardTtlMinutes.
 */

// Always render on request so the homepage reads the latest snapshot.
export const dynamic = "force-dynamic";

interface SearchParams {
  start?: string | string[]; // YYYY-MM-DD
  month?: string | string[]; // YYYY-MM
  view?: string | string[]; // list | month
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveViewMode(value: string | undefined): "list" | "month" {
  return value?.toLowerCase() === "month" ? "month" : "list";
}

export default async function AvailabilityPage({
  searchParams = {},
}: {
  searchParams?: SearchParams;
}) {
  const { file, env } = getConfig();
  const now = Date.now();
  const snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);

  const state = classifySnapshot(snapshot, now, {
    freshTtlMinutes: file.freshTtlMinutes,
    hardTtlMinutes: file.hardTtlMinutes,
  });

  // Fail-closed render
  if (state.status === "unavailable" || !state.snapshot) {
    return (
      <div className="page">
        <div className="fail-closed">
          <h1>Availability temporarily unavailable</h1>
          <p>
            This page could not load current availability. Please check back in a few
            minutes, or contact directly to confirm scheduling.
          </p>
        </div>
      </div>
    );
  }

  // Use the LIVE config timezone, not the snapshot-embedded one, so a
  // config change takes effect on the next page render without requiring
  // a new sync. The snapshot's UTC busy ranges are timezone-agnostic.
  const tz = file.timezone;
  const viewMode = resolveViewMode(firstParam(searchParams.view));

  // Determine defaults from "today" in the display timezone.
  const todayKey = todayInZone(tz, now);
  const todayMonthKey = todayKey.slice(0, 7);

  // Determine which week to show. Default: this week. `?start=YYYY-MM-DD` overrides.
  const requestedWeekParam = firstParam(searchParams.start)?.trim();
  const requestedWeek =
    requestedWeekParam && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekParam)
      ? requestedWeekParam
      : todayKey;

  const weekNav = resolveWeekNavigation({
    requestedDate: requestedWeek,
    fallbackDate: todayKey,
    windowStartUtc: state.snapshot.windowStartUtc,
    windowEndUtc: state.snapshot.windowEndUtc,
    timezone: tz,
  });

  // Determine which month to show. Default: this month. `?month=YYYY-MM` overrides.
  const requestedMonthParam = firstParam(searchParams.month)?.trim();
  const requestedMonth =
    requestedMonthParam && /^\d{4}-\d{2}$/.test(requestedMonthParam)
      ? requestedMonthParam
      : todayMonthKey;
  const clampedRequestedMonth = requestedMonth < todayMonthKey ? todayMonthKey : requestedMonth;

  const monthNav = resolveMonthNavigation({
    requestedMonth: clampedRequestedMonth,
    fallbackDate: todayKey,
    windowStartUtc: state.snapshot.windowStartUtc,
    windowEndUtc: state.snapshot.windowEndUtc,
    timezone: tz,
  });
  const monthCanGoPrev = monthNav.hasPrev && monthNav.monthKey > todayMonthKey;

  // List view: this week + next week (2 weeks, M–F each = up to 10 day rows).
  const weeks = buildDayBoard({
    snapshot: state.snapshot,
    startDate: weekNav.weekStart,
    weeks: 2,
    timezone: tz,
    workdayStartHour: file.workdayStartHour,
    workdayEndHour: file.workdayEndHour,
    nowMs: now,
  });

  // Month view: full month grid with one status per day.
  const month = buildMonthBoard({
    snapshot: state.snapshot,
    month: monthNav.monthKey,
    timezone: tz,
    nowMs: now,
  });

  const listToggleStart = viewMode === "month" ? `${monthNav.monthKey}-01` : weekNav.weekStart;
  const monthToggleKey = viewMode === "list" ? weekNav.weekStart.slice(0, 7) : monthNav.monthKey;

  return (
    <div className="page">
      <header className="header">
        <h1 className="title">{file.pageTitle}</h1>
      </header>

      <nav className="view-toggle" aria-label="View mode">
        <a
          className={`view-toggle-button${viewMode === "list" ? " active" : ""}`}
          href={`/?view=list&start=${listToggleStart}`}
          aria-label="Week view"
        >
          Week
        </a>
        <a
          className={`view-toggle-button${viewMode === "month" ? " active" : ""}`}
          href={`/?view=month&month=${monthToggleKey}`}
          aria-label="Month view"
        >
          Month
        </a>
      </nav>

      {viewMode === "list" ? (
        <>
          <nav className="nav" aria-label="Week navigation">
            <a
              className={`nav-button${weekNav.hasPrev ? "" : " is-disabled"}`}
              href={weekNav.hasPrev ? `/?view=list&start=${weekNav.prevStart}` : undefined}
              aria-label="Previous week"
              aria-disabled={!weekNav.hasPrev}
              tabIndex={weekNav.hasPrev ? undefined : -1}
            >
              ← Previous
            </a>
            <a className="nav-button" href={`/?view=list&start=${todayKey}`} aria-label="Today">
              Today
            </a>
            <a
              className={`nav-button${weekNav.hasNext ? "" : " is-disabled"}`}
              href={weekNav.hasNext ? `/?view=list&start=${weekNav.nextStart}` : undefined}
              aria-label="Next week"
              aria-disabled={!weekNav.hasNext}
              tabIndex={weekNav.hasNext ? undefined : -1}
            >
              Next →
            </a>
          </nav>

          <DayBoard weeks={weeks} />
        </>
      ) : (
        <>
          <nav className="nav" aria-label="Month navigation">
            <a
              className={`nav-button${monthCanGoPrev ? "" : " is-disabled"}`}
              href={monthCanGoPrev ? `/?view=month&month=${monthNav.prevMonth}` : undefined}
              aria-label="Previous month"
              aria-disabled={!monthCanGoPrev}
              tabIndex={monthCanGoPrev ? undefined : -1}
            >
              ← Previous
            </a>
            <a className="nav-button" href={`/?view=month&month=${todayMonthKey}`} aria-label="Today">
              Today
            </a>
            <a
              className={`nav-button${monthNav.hasNext ? "" : " is-disabled"}`}
              href={monthNav.hasNext ? `/?view=month&month=${monthNav.nextMonth}` : undefined}
              aria-label="Next month"
              aria-disabled={!monthNav.hasNext}
              tabIndex={monthNav.hasNext ? undefined : -1}
            >
              Next →
            </a>
          </nav>

          <MonthBoard month={month} todayKey={todayKey} />
        </>
      )}

    </div>
  );
}
