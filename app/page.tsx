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
import { ThemeToggle } from "@/components/ThemeToggle";
import Link from "next/link";

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
const TODAY_TIMEZONE = "America/New_York";

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

  // Single explicit timezone for current-day calculations.
  const todayKey = todayInZone(TODAY_TIMEZONE, now);
  const todayMonthKey = todayKey.slice(0, 7);

  // Determine which week to show. Default: this week. `?start=YYYY-MM-DD` overrides.
  const requestedWeekParam = firstParam(searchParams.start)?.trim();
  const requestedWeek =
    requestedWeekParam && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekParam)
      ? requestedWeekParam
      : todayKey;
  const clampedRequestedWeek = requestedWeek < todayKey ? todayKey : requestedWeek;

  const weekNav = resolveWeekNavigation({
    requestedDate: clampedRequestedWeek,
    fallbackDate: todayKey,
    windowStartUtc: state.snapshot.windowStartUtc,
    windowEndUtc: state.snapshot.windowEndUtc,
    timezone: tz,
  });
  const weekCanGoPrev = weekNav.hasPrev && weekNav.weekStart > todayKey;

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
  const initialWeeks = buildDayBoard({
    snapshot: state.snapshot,
    startDate: weekNav.weekStart,
    weeks: 2,
    timezone: tz,
    workdayStartHour: file.workdayStartHour,
    workdayEndHour: file.workdayEndHour,
    nowMs: now,
    todayKey,
  });
  const weekendTodayLabel = initialWeeks
    .flatMap((wk) => wk.days)
    .find((d) => d.isWeekend && d.isToday)?.label;
  const weekRowsSource = weekendTodayLabel && weekNav.hasNext
    ? buildDayBoard({
      snapshot: state.snapshot,
      startDate: weekNav.nextStart,
      weeks: 2,
      timezone: tz,
      workdayStartHour: file.workdayStartHour,
      workdayEndHour: file.workdayEndHour,
      nowMs: now,
      todayKey,
    })
    : initialWeeks;
  const visibleWeekRows = weekRowsSource
    .map((wk) => ({
      ...wk,
      days: wk.days.filter((d) => d.date >= todayKey),
    }))
    .filter((wk) => wk.days.length > 0);
  const visibleWeekRowsWithoutWeekendToday = visibleWeekRows
    .map((wk) => ({
      ...wk,
      days: wk.days.filter((d) => !(d.isWeekend && d.isToday)),
    }))
    .filter((wk) => wk.days.length > 0);

  // Month view: full month grid with one status per day.
  const month = buildMonthBoard({
    snapshot: state.snapshot,
    month: monthNav.monthKey,
    timezone: tz,
    nowMs: now,
    todayKey,
  });

  const listToggleStart = viewMode === "month" ? `${monthNav.monthKey}-01` : weekNav.weekStart;
  const monthToggleKey = viewMode === "list" ? weekNav.weekStart.slice(0, 7) : monthNav.monthKey;

  return (
    <div className="page">
      <header className="header">
        <h1 className="title">{file.pageTitle}</h1>
        <ThemeToggle />
      </header>

      <nav className="view-toggle" aria-label="View mode">
        <Link
          className={`view-toggle-button${viewMode === "list" ? " active" : ""}`}
          href={`/?view=list&start=${listToggleStart}`}
          aria-label="Week view"
          prefetch={false}
        >
          Week
        </Link>
        <Link
          className={`view-toggle-button${viewMode === "month" ? " active" : ""}`}
          href={`/?view=month&month=${monthToggleKey}`}
          aria-label="Month view"
          prefetch={false}
        >
          Month
        </Link>
      </nav>

      {viewMode === "list" ? (
        <>
          <nav className="nav" aria-label="Week navigation">
            {weekCanGoPrev ? (
              <Link className="nav-button" href={`/?view=list&start=${weekNav.prevStart}`} aria-label="Previous week" prefetch={false}>
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous week" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={`/?view=list&start=${todayKey}`} aria-label="Today" prefetch={false}>
              Today
            </Link>
            {weekNav.hasNext ? (
              <Link className="nav-button" href={`/?view=list&start=${weekNav.nextStart}`} aria-label="Next week" prefetch={false}>
                Next →
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Next week" aria-disabled tabIndex={-1}>
                Next →
              </a>
            )}
          </nav>

          <DayBoard weeks={visibleWeekRowsWithoutWeekendToday} weekendTodayLabel={weekendTodayLabel} />
        </>
      ) : (
        <>
          <nav className="nav" aria-label="Month navigation">
            {monthCanGoPrev ? (
              <Link className="nav-button" href={`/?view=month&month=${monthNav.prevMonth}`} aria-label="Previous month" prefetch={false}>
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous month" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={`/?view=month&month=${todayMonthKey}`} aria-label="Today" prefetch={false}>
              Today
            </Link>
            {monthNav.hasNext ? (
              <Link className="nav-button" href={`/?view=month&month=${monthNav.nextMonth}`} aria-label="Next month" prefetch={false}>
                Next →
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Next month" aria-disabled tabIndex={-1}>
                Next →
              </a>
            )}
          </nav>

          <MonthBoard month={month} todayKey={todayKey} />
        </>
      )}

    </div>
  );
}
