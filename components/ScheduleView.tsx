"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MonthBoardData, WeekGroup } from "@/lib/view";
import { DayBoard } from "@/components/DayBoard";
import { MonthBoard } from "@/components/MonthBoard";

const MIKE_SHOW_WEEKENDS_STORAGE_KEY = "la_schedule_mike_show_weekends";
const MIKE_SHOW_WEEKENDS_COOKIE_KEY = "la_schedule_mike_show_weekends";

interface Props {
  viewMode: "list" | "month";
  listToggleStart: string;
  monthToggleKey: string;
  initialEditorToken?: string;
  resolvedEditorId: string | null;
  editorCalendarId?: string;
  overtureCalendarId?: string;
  todayKey: string;
  todayMonthKey: string;
  weekRows: WeekGroup[];
  weekPrevHref: string;
  weekNextHref: string;
  weekCanGoPrev: boolean;
  weekCanGoNext: boolean;
  month: MonthBoardData;
  monthPrevHref: string;
  monthNextHref: string;
  monthCanGoPrev: boolean;
  monthCanGoNext: boolean;
  initialShowWeekends: boolean;
}

export function ScheduleView({
  viewMode,
  listToggleStart,
  monthToggleKey,
  initialEditorToken,
  resolvedEditorId,
  editorCalendarId,
  overtureCalendarId,
  todayKey,
  todayMonthKey,
  weekRows,
  weekPrevHref,
  weekNextHref,
  weekCanGoPrev,
  weekCanGoNext,
  month,
  monthPrevHref,
  monthNextHref,
  monthCanGoPrev,
  monthCanGoNext,
  initialShowWeekends,
}: Props) {
  const normalizedEditorId = resolvedEditorId?.trim().toLowerCase() ?? null;
  const isMikeEditor = normalizedEditorId === "mike";
  const [showWeekends, setShowWeekends] = useState(initialShowWeekends);

  useEffect(() => {
    if (!isMikeEditor) {
      setShowWeekends(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(MIKE_SHOW_WEEKENDS_STORAGE_KEY);
      setShowWeekends(raw === "1");
    } catch {
      setShowWeekends(initialShowWeekends);
    }
  }, [isMikeEditor, initialShowWeekends]);

  useEffect(() => {
    if (!isMikeEditor) return;
    const nextValue = showWeekends ? "1" : "0";
    try {
      window.localStorage.setItem(MIKE_SHOW_WEEKENDS_STORAGE_KEY, nextValue);
    } catch {
      // ignore persistence errors
    }
    document.cookie = `${MIKE_SHOW_WEEKENDS_COOKIE_KEY}=${nextValue}; path=/; max-age=31536000; samesite=lax`;
  }, [isMikeEditor, showWeekends]);

  const renderWeekendToggle = (className?: string) => {
    if (!isMikeEditor) return null;
    return (
      <div className={className ? `weekend-visibility-row ${className}` : "weekend-visibility-row"}>
        <label className="weekend-visibility-toggle">
          <input
            type="checkbox"
            checked={showWeekends}
            onChange={(event) => setShowWeekends(event.target.checked)}
          />
          <span>Weekends</span>
        </label>
      </div>
    );
  };

  return (
    <>
      <div className="view-controls-row">
        <nav className="view-toggle" aria-label="View mode">
          <Link
            className={`view-toggle-button${viewMode === "list" ? " active" : ""}`}
            href={`/?view=list&start=${listToggleStart}`}
            aria-label="Week view"
            prefetch={true}
            scroll={false}
          >
            Week
          </Link>
          <Link
            className={`view-toggle-button${viewMode === "month" ? " active" : ""}`}
            href={`/?view=month&month=${monthToggleKey}`}
            aria-label="Month view"
            prefetch={true}
            scroll={false}
          >
            Month
          </Link>
        </nav>
        {renderWeekendToggle("weekend-visibility-row--view-controls")}
      </div>

      {viewMode === "list" ? (
        <>
          <nav className="nav nav--with-weekends" aria-label="Week navigation">
            {weekCanGoPrev ? (
              <Link className="nav-button" href={weekPrevHref} aria-label="Previous week" prefetch={true} scroll={false}>
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous week" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={`/?view=list&start=${todayKey}`} aria-label="Today" prefetch={true} scroll={false}>
              Today
            </Link>
            {weekCanGoNext ? (
              <Link className="nav-button" href={weekNextHref} aria-label="Next week" prefetch={true} scroll={false}>
                Next →
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Next week" aria-disabled tabIndex={-1}>
                Next →
              </a>
            )}
            {renderWeekendToggle("weekend-visibility-row--nav")}
          </nav>

          <DayBoard
            weeks={weekRows}
            initialEditorToken={initialEditorToken}
            initialResolvedEditorId={resolvedEditorId}
            editorCalendarId={editorCalendarId}
            overtureCalendarId={overtureCalendarId}
            prevHref={weekPrevHref}
            nextHref={weekNextHref}
            canGoPrev={weekCanGoPrev}
            canGoNext={weekCanGoNext}
            showWeekends={showWeekends}
          />
        </>
      ) : (
        <>
          {renderWeekendToggle("weekend-visibility-row--month-landscape-top")}
          <div className="month-landscape-toolbar" aria-label="Month compact navigation">
            <span className="month-landscape-label">{month.label}</span>
            <div className="month-landscape-nav">
              {monthCanGoPrev ? (
                <Link
                  className="month-landscape-nav-button"
                  href={monthPrevHref}
                  aria-label="Previous month"
                  prefetch={true}
                  scroll={false}
                >
                  ←
                </Link>
              ) : (
                <span className="month-landscape-nav-button is-disabled" aria-hidden>
                  ←
                </span>
              )}
              <Link
                className="month-landscape-nav-button"
                href={`/?view=month&month=${todayMonthKey}`}
                aria-label="Today"
                prefetch={true}
                scroll={false}
              >
                Today
              </Link>
              {monthCanGoNext ? (
                <Link
                  className="month-landscape-nav-button"
                  href={monthNextHref}
                  aria-label="Next month"
                  prefetch={true}
                  scroll={false}
                >
                  →
                </Link>
              ) : (
                <span className="month-landscape-nav-button is-disabled" aria-hidden>
                  →
                </span>
              )}
            </div>
          </div>

          <nav className="nav nav--with-weekends" aria-label="Month navigation">
            {monthCanGoPrev ? (
              <Link className="nav-button" href={monthPrevHref} aria-label="Previous month" prefetch={true} scroll={false}>
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous month" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={`/?view=month&month=${todayMonthKey}`} aria-label="Today" prefetch={true} scroll={false}>
              Today
            </Link>
            {monthCanGoNext ? (
              <Link className="nav-button" href={monthNextHref} aria-label="Next month" prefetch={true} scroll={false}>
                Next →
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Next month" aria-disabled tabIndex={-1}>
                Next →
              </a>
            )}
            {renderWeekendToggle("weekend-visibility-row--nav")}
          </nav>

          <MonthBoard
            month={month}
            todayKey={todayKey}
            initialEditorToken={initialEditorToken}
            initialResolvedEditorId={resolvedEditorId}
            editorCalendarId={editorCalendarId}
            overtureCalendarId={overtureCalendarId}
            prevHref={monthPrevHref}
            nextHref={monthNextHref}
            canGoPrev={monthCanGoPrev}
            canGoNext={monthCanGoNext}
            showWeekends={showWeekends}
          />
        </>
      )}
    </>
  );
}
