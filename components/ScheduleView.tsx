"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { DateTime } from "luxon";
import { trimWeekRowsForScheduleList, type MonthBoardData, type WeekGroup } from "@/lib/view";
import type { BoardWindowPayload } from "@/lib/board-window";
import { DayBoard } from "@/components/DayBoard";
import { MonthBoard } from "@/components/MonthBoard";
import { sanitizeEditorToken } from "@/lib/editor-session";

const MIKE_SHOW_WEEKENDS_STORAGE_KEY = "la_schedule_mike_show_weekends";
const MIKE_SHOW_WEEKENDS_COOKIE_KEY = "la_schedule_mike_show_weekends";

type BoardWindowCache = Record<string, BoardWindowPayload>;

interface BoardWindowFetchParams {
  viewMode: "list" | "month";
  start?: string;
  month?: string;
  signal?: AbortSignal;
  editorToken?: string | null;
}

function buildBoardWindowCacheKey(payload: BoardWindowPayload): string {
  return `${payload.selected.view}:${payload.selected.weekStart}:${payload.selected.monthKey}`;
}

function isBoardWindowPayload(value: unknown): value is BoardWindowPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "ok") return false;
  const selected = record.selected;
  if (!selected || typeof selected !== "object") return false;
  const selectedRecord = selected as Record<string, unknown>;
  return typeof selectedRecord.weekStart === "string"
    && typeof selectedRecord.monthKey === "string"
    && (selectedRecord.view === "list" || selectedRecord.view === "month");
}

export async function fetchBoardWindowPayload({
  viewMode,
  start,
  month,
  signal,
  editorToken,
}: BoardWindowFetchParams): Promise<BoardWindowPayload | null> {
  if (typeof window === "undefined") return null;

  const url = new URL("/api/board/window", window.location.origin);
  url.searchParams.set("view", viewMode);
  if (start) {
    url.searchParams.set("start", start);
  }
  if (month) {
    url.searchParams.set("month", month);
  }

  const headers = new Headers({
    accept: "application/json",
  });
  const normalizedToken = sanitizeEditorToken(editorToken ?? null);
  if (normalizedToken) {
    headers.set("authorization", `Bearer ${normalizedToken}`);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return isBoardWindowPayload(payload) ? payload : null;
}

function withEditorToken(href: string, editorToken: string | null): string {
  if (!editorToken) return href;
  try {
    const url = new URL(href, "https://la-schedule-app.local");
    if (!url.searchParams.has("editor")) {
      url.searchParams.set("editor", editorToken);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

interface BoardNavigationTarget {
  viewMode: "list" | "month";
  weekStart: string;
  monthKey: string;
}

function resolveTargetFromHref(
  href: string,
  fallback: BoardNavigationTarget,
): BoardNavigationTarget | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(href, window.location.origin);
    const viewParam = url.searchParams.get("view");
    const viewMode: "list" | "month" = viewParam === "month" ? "month" : "list";
    const startParam = url.searchParams.get("start");
    const monthParam = url.searchParams.get("month");
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(startParam ?? "")
      ? (startParam as string)
      : fallback.weekStart;
    const monthKey = /^\d{4}-\d{2}$/.test(monthParam ?? "")
      ? (monthParam as string)
      : fallback.monthKey;
    return { viewMode, weekStart, monthKey };
  } catch {
    return null;
  }
}

function isClientInterceptClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return true;
}

function pushStateHref(href: string): void {
  if (typeof window === "undefined") return;
  const nextUrl = new URL(href, window.location.origin);
  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextPath !== currentPath) {
    window.history.pushState(null, "", nextPath);
  }
}

function deriveAdjacentWeekPayload(
  source: BoardWindowPayload,
  direction: -1 | 1,
): BoardWindowPayload | null {
  const weeks = source.weekWindow.weeks;
  const currentIndex = weeks.findIndex((week) => week.weekOf === source.selected.weekStart);
  if (currentIndex < 0) return null;
  const targetIndex = currentIndex + direction;
  const targetWeek = weeks[targetIndex];
  if (!targetWeek) return null;

  const currentWeekStart = DateTime.fromISO(source.todayKey, { zone: source.timezone })
    .startOf("week")
    .toFormat("yyyy-LL-dd");
  const twoWeekSlice = [targetWeek, weeks[targetIndex + 1]].filter(Boolean) as WeekGroup[];
  const trimmedWeekRows = trimWeekRowsForScheduleList({
    weeks: twoWeekSlice,
    selectedWeekStart: targetWeek.weekOf,
    currentWeekStart,
    todayKey: source.todayKey,
  });
  const prevStart = DateTime.fromISO(targetWeek.weekOf, { zone: source.timezone })
    .minus({ weeks: 1 })
    .toFormat("yyyy-LL-dd");
  const nextStart = DateTime.fromISO(targetWeek.weekOf, { zone: source.timezone })
    .plus({ weeks: 1 })
    .toFormat("yyyy-LL-dd");
  const hasNextInWindow = targetIndex < weeks.length - 1;
  const canGoPrev = targetWeek.weekOf > currentWeekStart;
  const canGoNext = hasNextInWindow || source.selected.weekNav.canGoNext;

  return {
    ...source,
    selected: {
      ...source.selected,
      view: "list",
      weekStart: targetWeek.weekOf,
      weekNav: {
        weekStart: targetWeek.weekOf,
        prevStart,
        nextStart,
        hasPrev: canGoPrev,
        hasNext: canGoNext,
        canGoPrev,
        canGoNext,
      },
    },
    selectedBoards: {
      ...source.selectedBoards,
      weekRows: trimmedWeekRows,
    },
  };
}

function deriveAdjacentMonthPayload(
  source: BoardWindowPayload,
  direction: -1 | 1,
): BoardWindowPayload | null {
  const months = source.monthWindow.months;
  const currentIndex = months.findIndex((entry) => entry.monthKey === source.selected.monthKey);
  if (currentIndex < 0) return null;
  const targetIndex = currentIndex + direction;
  const targetMonth = months[targetIndex];
  if (!targetMonth) return null;

  const prevMonth = DateTime.fromFormat(targetMonth.monthKey, "yyyy-LL", { zone: source.timezone })
    .minus({ months: 1 })
    .toFormat("yyyy-LL");
  const nextMonth = DateTime.fromFormat(targetMonth.monthKey, "yyyy-LL", { zone: source.timezone })
    .plus({ months: 1 })
    .toFormat("yyyy-LL");
  const hasNextInWindow = targetIndex < months.length - 1;
  const canGoPrev = targetMonth.monthKey > source.todayMonthKey;
  const canGoNext = hasNextInWindow || source.selected.monthNav.canGoNext;

  return {
    ...source,
    selected: {
      ...source.selected,
      view: "month",
      monthKey: targetMonth.monthKey,
      monthNav: {
        monthKey: targetMonth.monthKey,
        prevMonth,
        nextMonth,
        hasPrev: canGoPrev,
        hasNext: canGoNext,
        canGoPrev,
        canGoNext,
      },
    },
    selectedBoards: {
      ...source.selectedBoards,
      month: targetMonth,
    },
  };
}

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
  initialBoardWindowPayload: BoardWindowPayload;
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
  initialBoardWindowPayload,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigationEditorToken = sanitizeEditorToken(searchParams.get("editor"));
  const normalizedEditorId = resolvedEditorId?.trim().toLowerCase() ?? null;
  const isMikeEditor = normalizedEditorId === "mike";
  const [showWeekends, setShowWeekends] = useState(initialShowWeekends);
  const [boardWindowCache, setBoardWindowCache] = useState<BoardWindowCache>(() => ({
    [buildBoardWindowCacheKey(initialBoardWindowPayload)]: initialBoardWindowPayload,
  }));
  const [derivedPayload, setDerivedPayload] = useState<BoardWindowPayload | null>(null);

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

  useEffect(() => {
    const cacheKey = buildBoardWindowCacheKey(initialBoardWindowPayload);
    setBoardWindowCache((prev) => (
      prev[cacheKey] === initialBoardWindowPayload
        ? prev
        : { ...prev, [cacheKey]: initialBoardWindowPayload }
    ));
    setDerivedPayload(null);
  }, [initialBoardWindowPayload]);

  const effectiveViewMode = derivedPayload?.selected.view ?? viewMode;
  const effectiveWeekRows = derivedPayload?.selectedBoards.weekRows ?? weekRows;
  const effectiveMonth = derivedPayload?.selectedBoards.month ?? month;
  const effectiveWeekCanGoPrev = derivedPayload?.selected.weekNav.canGoPrev ?? weekCanGoPrev;
  const effectiveWeekCanGoNext = derivedPayload?.selected.weekNav.canGoNext ?? weekCanGoNext;
  const effectiveMonthCanGoPrev = derivedPayload?.selected.monthNav.canGoPrev ?? monthCanGoPrev;
  const effectiveMonthCanGoNext = derivedPayload?.selected.monthNav.canGoNext ?? monthCanGoNext;
  const effectiveListToggleStart = effectiveViewMode === "month"
    ? `${effectiveMonth.monthKey}-01`
    : (derivedPayload?.selected.weekStart ?? listToggleStart);
  const effectiveMonthToggleKey = effectiveViewMode === "list"
    ? (derivedPayload?.selected.weekStart.slice(0, 7) ?? monthToggleKey)
    : (derivedPayload?.selected.monthKey ?? monthToggleKey);
  const effectiveWeekPrevHref = derivedPayload
    ? `/?view=list&start=${derivedPayload.selected.weekNav.prevStart}`
    : weekPrevHref;
  const effectiveWeekNextHref = derivedPayload
    ? `/?view=list&start=${derivedPayload.selected.weekNav.nextStart}`
    : weekNextHref;
  const effectiveMonthPrevHref = derivedPayload
    ? `/?view=month&month=${derivedPayload.selected.monthNav.prevMonth}`
    : monthPrevHref;
  const effectiveMonthNextHref = derivedPayload
    ? `/?view=month&month=${derivedPayload.selected.monthNav.nextMonth}`
    : monthNextHref;
  const effectiveTodayKey = derivedPayload?.todayKey ?? todayKey;
  const effectiveTodayMonthKey = derivedPayload?.todayMonthKey ?? todayMonthKey;
  const listToggleHref = withEditorToken(`/?view=list&start=${effectiveListToggleStart}`, navigationEditorToken);
  const monthToggleHref = withEditorToken(`/?view=month&month=${effectiveMonthToggleKey}`, navigationEditorToken);
  const weekPrevNavHref = withEditorToken(effectiveWeekPrevHref, navigationEditorToken);
  const weekTodayHref = withEditorToken(`/?view=list&start=${effectiveTodayKey}`, navigationEditorToken);
  const weekNextNavHref = withEditorToken(effectiveWeekNextHref, navigationEditorToken);
  const monthPrevNavHref = withEditorToken(effectiveMonthPrevHref, navigationEditorToken);
  const monthTodayHref = withEditorToken(`/?view=month&month=${effectiveTodayMonthKey}`, navigationEditorToken);
  const monthNextNavHref = withEditorToken(effectiveMonthNextHref, navigationEditorToken);

  const handleBoardNavigate = useCallback((href: string) => {
    const sourcePayload = derivedPayload ?? initialBoardWindowPayload;
    const cachedSource = boardWindowCache[buildBoardWindowCacheKey(sourcePayload)] ?? sourcePayload;
    const target = resolveTargetFromHref(href, {
      viewMode: sourcePayload.selected.view,
      weekStart: sourcePayload.selected.weekStart,
      monthKey: sourcePayload.selected.monthKey,
    });
    if (!target) {
      router.push(href);
      return;
    }

    let nextPayload: BoardWindowPayload | null = null;
    if (sourcePayload.selected.view === "list" && target.viewMode === "list") {
      if (target.weekStart === sourcePayload.selected.weekNav.nextStart) {
        nextPayload = deriveAdjacentWeekPayload(cachedSource, 1);
      } else if (target.weekStart === sourcePayload.selected.weekNav.prevStart) {
        nextPayload = deriveAdjacentWeekPayload(cachedSource, -1);
      }
    } else if (sourcePayload.selected.view === "month" && target.viewMode === "month") {
      if (target.monthKey === sourcePayload.selected.monthNav.nextMonth) {
        nextPayload = deriveAdjacentMonthPayload(cachedSource, 1);
      } else if (target.monthKey === sourcePayload.selected.monthNav.prevMonth) {
        nextPayload = deriveAdjacentMonthPayload(cachedSource, -1);
      }
    }

    if (!nextPayload) {
      router.push(href);
      return;
    }

    setBoardWindowCache((prev) => ({
      ...prev,
      [buildBoardWindowCacheKey(nextPayload)]: nextPayload,
    }));
    setDerivedPayload(nextPayload);
    pushStateHref(href);
  }, [boardWindowCache, derivedPayload, initialBoardWindowPayload, router]);

  const navLinkClickHandler = useCallback((href: string) =>
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isClientInterceptClick(event)) return;
      event.preventDefault();
      handleBoardNavigate(href);
    }, [handleBoardNavigate]);

  const renderWeekendToggle = (className?: string) => {
    if (!isMikeEditor) return null;
    return (
      <div className={className ? `weekend-visibility-row ${className}` : "weekend-visibility-row"}>
        <button
          type="button"
          className={`weekend-visibility-toggle${showWeekends ? " is-active" : ""}`}
          aria-pressed={showWeekends}
          onClick={() => setShowWeekends((prev) => !prev)}
        >
          Weekends
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="view-controls-row">
        <nav className="view-toggle" aria-label="View mode">
          <Link
            className={`view-toggle-button${effectiveViewMode === "list" ? " active" : ""}`}
            href={listToggleHref}
            aria-label="Week view"
            prefetch={true}
            scroll={false}
          >
            Week
          </Link>
          <Link
            className={`view-toggle-button${effectiveViewMode === "month" ? " active" : ""}`}
            href={monthToggleHref}
            aria-label="Month view"
            prefetch={true}
            scroll={false}
          >
            Month
          </Link>
        </nav>
        {renderWeekendToggle("weekend-visibility-row--view-controls")}
      </div>

      {effectiveViewMode === "list" ? (
        <>
          <nav className="nav nav--with-weekends" aria-label="Week navigation">
            {effectiveWeekCanGoPrev ? (
              <Link
                className="nav-button"
                href={weekPrevNavHref}
                aria-label="Previous week"
                prefetch={true}
                scroll={false}
                onClick={navLinkClickHandler(weekPrevNavHref)}
              >
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous week" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={weekTodayHref} aria-label="Today" prefetch={true} scroll={false}>
              Today
            </Link>
            {effectiveWeekCanGoNext ? (
              <Link
                className="nav-button"
                href={weekNextNavHref}
                aria-label="Next week"
                prefetch={true}
                scroll={false}
                onClick={navLinkClickHandler(weekNextNavHref)}
              >
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
            weeks={effectiveWeekRows}
            initialEditorToken={initialEditorToken}
            initialResolvedEditorId={resolvedEditorId}
            editorCalendarId={editorCalendarId}
            overtureCalendarId={overtureCalendarId}
            prevHref={weekPrevNavHref}
            nextHref={weekNextNavHref}
            canGoPrev={effectiveWeekCanGoPrev}
            canGoNext={effectiveWeekCanGoNext}
            showWeekends={showWeekends}
            onNavigate={handleBoardNavigate}
          />
        </>
      ) : (
        <>
          <div className="month-landscape-toolbar" aria-label="Month compact navigation">
            <span className="month-landscape-label">{effectiveMonth.label}</span>
            <div className="month-landscape-nav">
              <Link
                className="month-landscape-nav-button"
                href={monthTodayHref}
                aria-label="Today"
                prefetch={true}
                scroll={false}
              >
                Today
              </Link>
            </div>
          </div>

          <nav className="nav nav--with-weekends" aria-label="Month navigation">
            {effectiveMonthCanGoPrev ? (
              <Link
                className="nav-button"
                href={monthPrevNavHref}
                aria-label="Previous month"
                prefetch={true}
                scroll={false}
                onClick={navLinkClickHandler(monthPrevNavHref)}
              >
                ← Previous
              </Link>
            ) : (
              <a className="nav-button is-disabled" aria-label="Previous month" aria-disabled tabIndex={-1}>
                ← Previous
              </a>
            )}
            <Link className="nav-button" href={monthTodayHref} aria-label="Today" prefetch={true} scroll={false}>
              Today
            </Link>
            {effectiveMonthCanGoNext ? (
              <Link
                className="nav-button"
                href={monthNextNavHref}
                aria-label="Next month"
                prefetch={true}
                scroll={false}
                onClick={navLinkClickHandler(monthNextNavHref)}
              >
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
            month={effectiveMonth}
            todayKey={effectiveTodayKey}
            initialEditorToken={initialEditorToken}
            initialResolvedEditorId={resolvedEditorId}
            editorCalendarId={editorCalendarId}
            overtureCalendarId={overtureCalendarId}
            prevHref={monthPrevNavHref}
            nextHref={monthNextNavHref}
            canGoPrev={effectiveMonthCanGoPrev}
            canGoNext={effectiveMonthCanGoNext}
            showWeekends={showWeekends}
            onNavigate={handleBoardNavigate}
          />
        </>
      )}
    </>
  );
}
