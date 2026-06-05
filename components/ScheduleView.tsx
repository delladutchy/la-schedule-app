"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { DateTime } from "luxon";
import { trimWeekRowsForScheduleList, type MonthBoardData, type WeekGroup } from "@/lib/view";
import type { BoardWindowPayload } from "@/lib/board-window";
import { DayBoard } from "@/components/DayBoard";
import { MonthBoard } from "@/components/MonthBoard";
import { sanitizeEditorToken } from "@/lib/editor-session";
import {
  buildViewKey as buildPersistedViewKey,
  clearCache as clearPersistedCache,
  editorIdToBucket,
  pickFreshestForView,
  readCache as readPersistedCache,
  writeCache as writePersistedCache,
} from "@/lib/board-window-cache";
import {
  isPayloadAnImprovement,
  isPayloadRenderableForViewTarget,
} from "@/lib/schedule-view-state";
import {
  deriveWeekAnchorDateForMonth,
  deriveFocusedDateForMonthKey,
  deriveFocusedDateForWeekTarget,
  deriveListStartFromFocusedDate,
  deriveMonthKeyFromFocusedDate,
  isTodayClickTarget,
  normalizeWeekStartForCacheLookup,
} from "@/lib/today-navigation";

const BACKGROUND_REFRESH_DEBOUNCE_MS = 200;
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 30_000;
// SSR snapshot is considered "recent enough" to skip the immediate mount-time
// revalidation. The visibility-change refresh still fires when the user
// returns to the tab, so freshness is bounded.
const MOUNT_REFRESH_SKIP_MAX_AGE_MS = 60_000;

const MIKE_SHOW_WEEKENDS_STORAGE_KEY = "la_schedule_mike_show_weekends";
const MIKE_SHOW_WEEKENDS_COOKIE_KEY = "la_schedule_mike_show_weekends";

type BoardWindowCache = Record<string, BoardWindowPayload>;

interface BoardWindowFetchParams {
  viewMode: "list" | "month";
  start?: string;
  month?: string;
  scope?: "selected" | "full";
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
  scope,
  signal,
  editorToken,
}: BoardWindowFetchParams): Promise<BoardWindowPayload | null> {
  if (typeof window === "undefined") return null;

  const url = new URL("/api/board/window", window.location.origin);
  url.searchParams.set("view", viewMode);
  if (scope === "selected") {
    url.searchParams.set("scope", "selected");
  }
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

/**
 * Loading skeleton for the board area. Rendered while the static-shell SSR
 * has only a synthetic payload and the client has neither hydrated the
 * localStorage cache nor received a /api/board/window response yet. Mimics
 * the board layout to avoid layout shift, fades in with a small delay so a
 * cache-hit microsecond render never paints it.
 */
function BoardSkeleton({
  variant,
  visibleDayCount,
}: {
  variant: "list" | "month";
  visibleDayCount: number;
}): JSX.Element {
  if (variant === "list") {
    return (
      <div
        className="board board-skeleton"
        role="status"
        aria-busy="true"
        aria-label="Loading availability"
      >
        <div className="board-week board-week--skeleton">
          <div className="board-skeleton-week-label" aria-hidden="true" />
          <ul className="board-days">
            {Array.from({ length: 10 }).map((_, dayIdx) => (
              <li key={dayIdx} className="board-skeleton-row" aria-hidden="true" />
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <section
      className="month-board board-skeleton"
      aria-busy="true"
      aria-label="Loading availability"
      style={{ ["--month-visible-days" as string]: String(visibleDayCount) }}
    >
      <div className="month-weekdays" aria-hidden="true">
        {Array.from({ length: visibleDayCount }).map((_, i) => (
          <div key={i} className="month-weekday">&nbsp;</div>
        ))}
      </div>
      <div className="month-grid">
        {Array.from({ length: 6 }).map((_, weekIdx) => (
          <div key={weekIdx} className="month-week month-week--skeleton">
            {Array.from({ length: visibleDayCount }).map((_, dayIdx) => (
              <div key={dayIdx} className="month-skeleton-cell" aria-hidden="true" />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
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

interface RouteTargetCoordinates {
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

function deriveWeekPayloadForTarget(
  source: BoardWindowPayload,
  targetWeekStart: string,
): BoardWindowPayload | null {
  const weeks = source.weekWindow.weeks;
  const targetIndex = weeks.findIndex((week) => week.weekOf === targetWeekStart);
  if (targetIndex < 0) return null;
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

function deriveMonthPayloadForTarget(
  source: BoardWindowPayload,
  targetMonthKey: string,
): BoardWindowPayload | null {
  const months = source.monthWindow.months;
  const targetIndex = months.findIndex((entry) => entry.monthKey === targetMonthKey);
  if (targetIndex < 0) return null;
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

export function resolveRenderableViewPayload(opts: {
  viewMode: "list" | "month";
  targetWeekStart: string;
  targetMonthKey: string;
  directPayload: BoardWindowPayload | null;
  listPayload: BoardWindowPayload | null;
  monthPayload: BoardWindowPayload | null;
  initialBoardWindowPayload: BoardWindowPayload;
  boardWindowCache: BoardWindowCache;
}): BoardWindowPayload | null {
  if (isPayloadRenderableForViewTarget({
    viewMode: opts.viewMode,
    target: {
      weekStart: opts.targetWeekStart,
      monthKey: opts.targetMonthKey,
    },
    payload: opts.directPayload,
  })) {
    return opts.directPayload;
  }

  const sourceCandidates: BoardWindowPayload[] = [];
  const pushCandidate = (payload: BoardWindowPayload | null) => {
    if (!payload) return;
    sourceCandidates.push(payload);
  };
  pushCandidate(opts.listPayload);
  pushCandidate(opts.monthPayload);
  pushCandidate(opts.initialBoardWindowPayload);
  for (const payload of Object.values(opts.boardWindowCache)) {
    sourceCandidates.push(payload);
  }

  for (const source of sourceCandidates) {
    // Do not de-dupe by selected-view cache key here.
    // A selected-only payload and a richer full-window payload can share the
    // same selected coordinates; skipping the latter can prevent deriving the
    // active month/week target and temporarily blank the board.
    const derived = opts.viewMode === "list"
      ? deriveWeekPayloadForTarget(source, opts.targetWeekStart)
      : deriveMonthPayloadForTarget(source, opts.targetMonthKey);
    if (!derived) continue;
    if (isPayloadRenderableForViewTarget({
      viewMode: opts.viewMode,
      target: {
        weekStart: opts.targetWeekStart,
        monthKey: opts.targetMonthKey,
      },
      payload: derived,
    })) {
      return derived;
    }
  }

  return null;
}

function deriveInitialFocusedDate(payload: BoardWindowPayload, activeView: "list" | "month"): string {
  if (activeView === "list") {
    return payload.selected.weekStart;
  }
  return deriveFocusedDateForMonthKey({
    monthKey: payload.selected.monthKey,
    timezone: payload.timezone,
    fallbackDate: payload.todayKey,
    dayOfMonth: 1,
  });
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
  /**
   * True when `initialBoardWindowPayload` is a synthesized skeleton produced
   * by the static-shell SSR rather than a real server-built payload. In that
   * mode we never write it back to localStorage (its sentinel timestamp would
   * shadow a fresher cached entry on the next visit), and the mount-time
   * /api/board/window fetch always fires because the payload's snapshotStatus
   * is `"stale"` — defeating the skip-fresh optimization.
   */
  initialPayloadIsSynthetic?: boolean;
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
  initialPayloadIsSynthetic = false,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigationEditorToken = sanitizeEditorToken(searchParams.get("editor"));
  const normalizedEditorId = resolvedEditorId?.trim().toLowerCase() ?? null;
  const isMikeEditor = normalizedEditorId === "mike";
  const persistedBucket = editorIdToBucket(normalizedEditorId);
  const [showWeekends, setShowWeekends] = useState(initialShowWeekends);
  const [boardWindowCache, setBoardWindowCache] = useState<BoardWindowCache>(() => ({
    [buildBoardWindowCacheKey(initialBoardWindowPayload)]: initialBoardWindowPayload,
  }));
  // Per-view displayed payload slots. `activeView` (from the URL via the
  // `viewMode` prop) decides which slot drives rendering; the other slot
  // is preserved so cross-view toggles can paint instantly from session
  // memory. Background responses route to their matching slot by
  // `incoming.selected.view`, so a list response can never overwrite the
  // month slot and vice versa.
  const [listPayload, setListPayload] = useState<BoardWindowPayload | null>(null);
  const [monthPayload, setMonthPayload] = useState<BoardWindowPayload | null>(null);
  // Source of truth for "today". Derived from the browser clock so it is
  // never stale from a cached payload (which can carry yesterday's todayKey
  // after an overnight session). The useState initializer runs immediately
  // on the client; the typeof-window guard covers the server-side render of
  // this client component so hydration produces the same markup.
  const [clientTodayKey] = useState<string>(() => {
    if (typeof window === "undefined") return initialBoardWindowPayload.todayKey;
    return DateTime.now()
      .setZone(initialBoardWindowPayload.timezone)
      .toFormat("yyyy-LL-dd");
  });
  const [focusedDate, setFocusedDate] = useState<string>(() =>
    deriveInitialFocusedDate(initialBoardWindowPayload, viewMode));
  const [hasExplicitFocusedDate, setHasExplicitFocusedDate] = useState(false);
  const [todayPulseToken, setTodayPulseToken] = useState(0);
  const lastBackgroundRefreshAtRef = useRef(0);
  const [routeTarget, setRouteTarget] = useState<RouteTargetCoordinates>(() => ({
    weekStart: normalizeWeekStartForCacheLookup({
      weekStart: initialBoardWindowPayload.selected.weekStart,
      timezone: initialBoardWindowPayload.timezone,
    }),
    monthKey: initialBoardWindowPayload.selected.monthKey,
  }));

  // Route target is controlled by URL/navigation actions only.
  // Date/job clicks update focusedDate (cross-view context) but must not
  // move the active render/fetch target.
  const routeTargetWeekStart = routeTarget.weekStart;
  const routeTargetMonthKey = routeTarget.monthKey;

  const renderableListPayload = resolveRenderableViewPayload({
    viewMode: "list",
    targetWeekStart: routeTargetWeekStart,
    targetMonthKey: routeTargetMonthKey,
    directPayload: listPayload,
    listPayload,
    monthPayload,
    initialBoardWindowPayload,
    boardWindowCache,
  });
  const renderableMonthPayload = resolveRenderableViewPayload({
    viewMode: "month",
    targetWeekStart: routeTargetWeekStart,
    targetMonthKey: routeTargetMonthKey,
    directPayload: monthPayload,
    listPayload,
    monthPayload,
    initialBoardWindowPayload,
    boardWindowCache,
  });

  const activeView: "list" | "month" = viewMode;
  const activePayload: BoardWindowPayload | null =
    activeView === "list" ? renderableListPayload : renderableMonthPayload;
  const hasRenderableActivePayload = activePayload != null;

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
    // Intentionally NO setListPayload(null) / setMonthPayload(null) here.
    // The per-view slots persist across navigations — including Today
    // resets and cross-view toggles — so the user keeps seeing real data
    // while the next URL's data is fetched. Skeleton appears only when
    // the slot for the active view has truly never been populated.
  }, [initialBoardWindowPayload]);

  useEffect(() => {
    setRouteTarget({
      weekStart: normalizeWeekStartForCacheLookup({
        weekStart: initialBoardWindowPayload.selected.weekStart,
        timezone: initialBoardWindowPayload.timezone,
      }),
      monthKey: initialBoardWindowPayload.selected.monthKey,
    });
  }, [
    initialBoardWindowPayload.selected.weekStart,
    initialBoardWindowPayload.selected.monthKey,
    initialBoardWindowPayload.timezone,
  ]);

  // Hydrate persisted cache on mount and on URL change. Routes the cached
  // entry to its matching slot by `cached.selected.view`, so a list cache
  // entry can never bleed into the month slot.
  useEffect(() => {
    const ssrViewKey = buildPersistedViewKey(initialBoardWindowPayload);
    const entry = readPersistedCache(persistedBucket);
    const fresher = pickFreshestForView(entry, persistedBucket, ssrViewKey, initialBoardWindowPayload);
    if (!fresher) return;
    setBoardWindowCache((prev) => ({
      ...prev,
      [buildBoardWindowCacheKey(fresher)]: fresher,
    }));
      const target = {
        weekStart: routeTargetWeekStart,
        monthKey: routeTargetMonthKey,
      };
      if (fresher.selected.view === "list") {
        setListPayload((prev) => (
          isPayloadAnImprovement({ incoming: fresher, current: prev, target })
          ? fresher
          : prev
      ));
    } else if (fresher.selected.view === "month") {
      setMonthPayload((prev) => (
        isPayloadAnImprovement({ incoming: fresher, current: prev, target })
          ? fresher
          : prev
      ));
    }
  }, [
    initialBoardWindowPayload,
    persistedBucket,
    routeTargetWeekStart,
    routeTargetMonthKey,
  ]);

  // Write-through: every real payload that drives the UI is persisted under
  // the active editor's bucket. The static-shell skeleton (when
  // `initialPayloadIsSynthetic` is true) is intentionally NOT persisted —
  // its sentinel timestamp would shadow fresher cached entries on later
  // visits.
  useEffect(() => {
    if (initialPayloadIsSynthetic) return;
    writePersistedCache(persistedBucket, initialBoardWindowPayload);
  }, [persistedBucket, initialBoardWindowPayload, initialPayloadIsSynthetic]);

  useEffect(() => {
    if (!listPayload) return;
    writePersistedCache(persistedBucket, listPayload);
  }, [persistedBucket, listPayload]);

  useEffect(() => {
    if (!monthPayload) return;
    writePersistedCache(persistedBucket, monthPayload);
  }, [persistedBucket, monthPayload]);

  // Background revalidation: after first paint, refresh /api/board/window
  // for the active selection and reconcile if the server has fresher data.
  // Also refresh when the user returns to the tab after >30s away.
  //
  // Mount path is two-stage:
  //   1. ?scope=selected → returns ONLY the selected week/month (skips the
  //      heavy prev/next precompute). Returns fast — that's the perceived
  //      load time the user feels.
  //   2. Default scope (full) → returns the wide window so prev/next can
  //      derive client-side without another server hit. Runs in parallel
  //      with stage 1; its result replaces the in-memory payload when it
  //      arrives because it has strictly more data.
  //
  // Visibility path stays single-stage (full) because the user already saw
  // data and we want one authoritative response.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    // Route incoming payloads to their matching slot by
    // `incoming.selected.view`. A list response can never overwrite the
    // month slot, and vice versa — view safety is structural, not
    // checked by a compatibility predicate. Within a slot,
    // `isPayloadAnImprovement` arbitrates timestamps, URL-target
    // matching, and wide-window richness so a fresh response replaces
    // a stale-coord fallback but a same-coord response only upgrades
    // when it has more data.
    const applyResponse = (incoming: BoardWindowPayload): void => {
      if (cancelled) return;
      setBoardWindowCache((prev) => ({
        ...prev,
        [buildBoardWindowCacheKey(incoming)]: incoming,
      }));
      const target = {
        weekStart: routeTargetWeekStart,
        monthKey: routeTargetMonthKey,
      };
      if (incoming.selected.view === "list") {
        setListPayload((prev) => (
          isPayloadAnImprovement({ incoming, current: prev, target })
            ? incoming
            : prev
        ));
      } else if (incoming.selected.view === "month") {
        setMonthPayload((prev) => (
          isPayloadAnImprovement({ incoming, current: prev, target })
            ? incoming
            : prev
        ));
      }
      // Any other view value (defensive) is silently dropped.
    };

    const refresh = async (reason: "mount" | "visible") => {
      try {
        const now = Date.now();
        if (now - lastBackgroundRefreshAtRef.current < BACKGROUND_REFRESH_MIN_INTERVAL_MS
            && reason !== "mount") {
          return;
        }
        lastBackgroundRefreshAtRef.current = now;
        // The URL's coordinates are the source of truth for what to fetch.
        // Both mount and visibility refreshes target what the user is
        // currently navigated to; in-flight responses for old URLs are
        // dropped by the `cancelled` guard above.
        const baseParams = {
          viewMode: activeView,
          start: routeTargetWeekStart,
          month: routeTargetMonthKey,
          signal: controller.signal,
          editorToken: navigationEditorToken,
        };

        if (reason === "mount") {
          // Fire both stages in parallel. Stage 1 (selected) typically
          // returns first and triggers the first real paint; stage 2 (full)
          // arrives shortly after and quietly upgrades the cached payload.
          const fastPromise = fetchBoardWindowPayload({ ...baseParams, scope: "selected" });
          const fullPromise = fetchBoardWindowPayload({ ...baseParams });
          fastPromise.then((fast) => { if (fast) applyResponse(fast); }).catch(() => { /* aborted */ });
          const full = await fullPromise;
          if (full) applyResponse(full);
          return;
        }

        // Visibility refresh: single full fetch.
        const fresh = await fetchBoardWindowPayload(baseParams);
        if (fresh) applyResponse(fresh);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        throw err;
      }
    };

    const ssrGeneratedMs = Date.parse(initialBoardWindowPayload.generatedAtUtc);
    const ssrAgeMs = Number.isFinite(ssrGeneratedMs)
      ? Date.now() - ssrGeneratedMs
      : Number.POSITIVE_INFINITY;
    const ssrIsFreshAndRecent =
      initialBoardWindowPayload.snapshotStatus === "ok"
      && ssrAgeMs >= 0
      && ssrAgeMs < MOUNT_REFRESH_SKIP_MAX_AGE_MS;

    let debounceId: number | null = null;
    if (!hasRenderableActivePayload) {
      // Recovery path: if target-aware gating has no renderable payload yet,
      // fetch the focused target immediately instead of waiting for debounce.
      console.info("[perf] auto refresh scheduled reason=missing_target_payload");
      void refresh("mount");
    } else if (ssrIsFreshAndRecent) {
      // [perf] temporary instrumentation — remove once perf review concludes.
      console.info(`[perf] auto refresh scheduled reason=skipped_ssr_fresh ssrAgeMs=${ssrAgeMs}`);
      // Treat the SSR payload as already up-to-date so the throttle window
      // reflects when the user last received fresh data.
      lastBackgroundRefreshAtRef.current = Date.now();
    } else {
      debounceId = window.setTimeout(() => {
        // [perf] temporary instrumentation — remove once perf review concludes.
        console.info(`[perf] auto refresh scheduled reason=mount delayMs=${BACKGROUND_REFRESH_DEBOUNCE_MS} ssrAgeMs=${ssrAgeMs}`);
        void refresh("mount");
      }, BACKGROUND_REFRESH_DEBOUNCE_MS);
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // [perf] temporary instrumentation — remove once perf review concludes.
        console.info(`[perf] auto refresh scheduled reason=visible`);
        void refresh("visible");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      controller.abort();
      if (debounceId !== null) {
        window.clearTimeout(debounceId);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // We intentionally only re-run on editor / SSR-payload identity
    // changes; later derivation updates should not retrigger fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    persistedBucket,
    initialBoardWindowPayload,
    navigationEditorToken,
    activeView,
    routeTargetWeekStart,
    routeTargetMonthKey,
    hasRenderableActivePayload,
  ]);

  const invalidatePersistedCache = useCallback(() => {
    clearPersistedCache(persistedBucket);
  }, [persistedBucket]);

  // The URL is the source of truth for the active view; the slot for that
  // view supplies the data. We deliberately do NOT let the slot's
  // `selected.view` override `activeView` — that's the inversion that
  // caused Week/Month toggles to show stale-view content.
  const effectiveViewMode = activeView;
  const effectiveWeekRows = renderableListPayload?.selectedBoards.weekRows ?? weekRows;
  const effectiveMonth = renderableMonthPayload?.selectedBoards.month ?? month;
  const effectiveWeekCanGoPrev =
    renderableListPayload?.selected.weekNav.canGoPrev ?? weekCanGoPrev;
  const effectiveWeekCanGoNext =
    renderableListPayload?.selected.weekNav.canGoNext ?? weekCanGoNext;
  const effectiveMonthCanGoPrev =
    renderableMonthPayload?.selected.monthNav.canGoPrev ?? monthCanGoPrev;
  const effectiveMonthCanGoNext =
    renderableMonthPayload?.selected.monthNav.canGoNext ?? monthCanGoNext;
  const focusedDateMonthKey = deriveMonthKeyFromFocusedDate({
    focusedDate,
    timezone: activePayload?.timezone ?? initialBoardWindowPayload.timezone,
    fallbackMonthKey: "",
  });
  const monthToWeekPreferredDate =
    hasExplicitFocusedDate && focusedDateMonthKey === effectiveMonth.monthKey
      ? focusedDate
      : null;
  const effectiveListToggleStart = effectiveViewMode === "month"
      ? deriveWeekAnchorDateForMonth({
        monthKey: effectiveMonth.monthKey,
        timezone: activePayload?.timezone ?? initialBoardWindowPayload.timezone,
        preferredDate: monthToWeekPreferredDate,
        todayKey: activePayload?.todayKey ?? todayKey,
      })
    : deriveListStartFromFocusedDate({
        focusedDate,
        fallbackStartDate: renderableListPayload?.selected.weekStart ?? listToggleStart,
      });
  const effectiveMonthToggleKey = deriveMonthKeyFromFocusedDate({
    focusedDate,
    timezone: activePayload?.timezone ?? initialBoardWindowPayload.timezone,
    fallbackMonthKey: effectiveViewMode === "list"
      ? (renderableListPayload?.selected.weekStart.slice(0, 7) ?? monthToggleKey)
      : (renderableMonthPayload?.selected.monthKey ?? monthToggleKey),
  });
  const effectiveWeekPrevHref = renderableListPayload
    ? `/?view=list&start=${renderableListPayload.selected.weekNav.prevStart}`
    : weekPrevHref;
  const effectiveWeekNextHref = renderableListPayload
    ? `/?view=list&start=${renderableListPayload.selected.weekNav.nextStart}`
    : weekNextHref;
  const effectiveMonthPrevHref = renderableMonthPayload
    ? `/?view=month&month=${renderableMonthPayload.selected.monthNav.prevMonth}`
    : monthPrevHref;
  const effectiveMonthNextHref = renderableMonthPayload
    ? `/?view=month&month=${renderableMonthPayload.selected.monthNav.nextMonth}`
    : monthNextHref;
  const effectiveTodayKey = clientTodayKey;
  const effectiveTodayMonthKey = clientTodayKey.slice(0, 7);
  const listToggleHref = withEditorToken(`/?view=list&start=${effectiveListToggleStart}`, navigationEditorToken);
  const monthToggleHref = withEditorToken(`/?view=month&month=${effectiveMonthToggleKey}`, navigationEditorToken);
  const weekPrevNavHref = withEditorToken(effectiveWeekPrevHref, navigationEditorToken);
  const weekTodayHref = withEditorToken(`/?view=list&start=${effectiveTodayKey}`, navigationEditorToken);
  const weekNextNavHref = withEditorToken(effectiveWeekNextHref, navigationEditorToken);
  const monthPrevNavHref = withEditorToken(effectiveMonthPrevHref, navigationEditorToken);
  const monthTodayHref = withEditorToken(`/?view=month&month=${effectiveTodayMonthKey}`, navigationEditorToken);
  const monthNextNavHref = withEditorToken(effectiveMonthNextHref, navigationEditorToken);

  // Loading state: shell is up but no real data for the **active view**
  // has ever arrived. Once the active view's slot is populated — by
  // localStorage cache hydration, a background fetch, or a prev/next
  // derivation — this flips to false and never goes back. Cross-view
  // toggles never re-enter the skeleton if the user has visited that
  // view before in this session (its slot persists).
  const isLoading = initialPayloadIsSynthetic && !activePayload;
  const isWeekendsHidden = isMikeEditor && !showWeekends;
  const skeletonVisibleDayCount = isWeekendsHidden ? 5 : 7;

  // After 500 ms of sustained loading, show "Loading calendar…" so a slow
  // /api/board/window response doesn't look stuck. Hidden again the moment
  // any data arrives.
  const [showExtendedLoadingText, setShowExtendedLoadingText] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setShowExtendedLoadingText(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setShowExtendedLoadingText(true);
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [isLoading]);

  const handleBoardNavigate = useCallback((href: string) => {
    // The source for derivation is the active view's slot. If it's
    // empty (true first load), we fall back to the SSR shell so
    // resolveTargetFromHref still has coordinates; the derive call
    // will miss and we'll go through router.push naturally.
    const sourcePayload = activePayload ?? initialBoardWindowPayload;
    const cachedSource = boardWindowCache[buildBoardWindowCacheKey(sourcePayload)] ?? sourcePayload;
    const target = resolveTargetFromHref(href, {
      viewMode: activeView,
      weekStart: sourcePayload.selected.weekStart,
      monthKey: sourcePayload.selected.monthKey,
    });
    if (!target) {
      router.push(href);
      return;
    }

    // Today bumps the pulse token but follows the same navigation
    // coordinate flow as prev/next.
    const isTodayNavigation = isTodayClickTarget(
      target,
      clientTodayKey,
      clientTodayKey.slice(0, 7),
    );
    if (isTodayNavigation) {
      setTodayPulseToken((t) => t + 1);
    }

    const currentFocusDayOfMonth = (() => {
      const dt = focusedDate
        ? DateTime.fromISO(focusedDate, { zone: sourcePayload.timezone })
        : null;
      return dt?.isValid ? dt.day : undefined;
    })();
    const normalizedTargetWeekStart = target.viewMode === "list"
      ? normalizeWeekStartForCacheLookup({
          weekStart: target.weekStart,
          timezone: sourcePayload.timezone,
        })
      : target.weekStart;

    if (isTodayNavigation) {
      setHasExplicitFocusedDate(false);
      setFocusedDate(clientTodayKey);
    } else if (target.viewMode === "list") {
      setHasExplicitFocusedDate(false);
      if (activeView !== "list") {
        setFocusedDate(target.weekStart);
      } else {
        setFocusedDate(deriveFocusedDateForWeekTarget({
          focusedDate,
          targetWeekStart: normalizedTargetWeekStart,
          sourceWeekStart: sourcePayload.selected.weekStart,
          timezone: sourcePayload.timezone,
        }));
      }
    } else {
      setHasExplicitFocusedDate(false);
      setFocusedDate(deriveFocusedDateForMonthKey({
        monthKey: target.monthKey,
        timezone: sourcePayload.timezone,
        fallbackDate: clientTodayKey,
        dayOfMonth: currentFocusDayOfMonth ?? 1,
      }));
    }

    // Resolve same-view prev/next/Today via direct lookup in the cached
    // weekWindow / monthWindow. Targets outside the precomputed window
    // (or cross-view toggles) fall through to router.push so SSR can
    // produce a fresh window centered on the target.
    let nextPayload: BoardWindowPayload | null = null;
    if (activeView === "list" && target.viewMode === "list") {
      nextPayload = deriveWeekPayloadForTarget(cachedSource, normalizedTargetWeekStart);
    } else if (activeView === "month" && target.viewMode === "month") {
      nextPayload = deriveMonthPayloadForTarget(cachedSource, target.monthKey);
    }

    if (!nextPayload) {
      setRouteTarget({
        weekStart: normalizedTargetWeekStart,
        monthKey: target.monthKey,
      });
      router.push(href, { scroll: false });
      return;
    }

    setRouteTarget({
      weekStart: normalizedTargetWeekStart,
      monthKey: target.monthKey,
    });
    setBoardWindowCache((prev) => ({
      ...prev,
      [buildBoardWindowCacheKey(nextPayload)]: nextPayload,
    }));
    if (nextPayload.selected.view === "list") {
      setListPayload(nextPayload);
    } else if (nextPayload.selected.view === "month") {
      setMonthPayload(nextPayload);
    }
    router.push(href, { scroll: false });
  }, [activePayload, activeView, boardWindowCache, focusedDate, initialBoardWindowPayload, router]);

  const handleDateFocus = useCallback((date: string) => {
    setHasExplicitFocusedDate(true);
    setFocusedDate(date);
  }, []);

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
            onClick={navLinkClickHandler(listToggleHref)}
          >
            Week
          </Link>
          <Link
            className={`view-toggle-button${effectiveViewMode === "month" ? " active" : ""}`}
            href={monthToggleHref}
            aria-label="Month view"
            prefetch={true}
            scroll={false}
            onClick={navLinkClickHandler(monthToggleHref)}
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
            <Link
              className="nav-button"
              href={weekTodayHref}
              aria-label="Today"
              prefetch={true}
              scroll={false}
              onClick={navLinkClickHandler(weekTodayHref)}
            >
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

          {isLoading ? (
            <>
              <BoardSkeleton variant="list" visibleDayCount={skeletonVisibleDayCount} />
              {showExtendedLoadingText ? (
                <div
                  className="board-loading-extended-text"
                  role="status"
                  aria-live="polite"
                >
                  Loading calendar…
                </div>
              ) : null}
            </>
          ) : (
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
              onDateFocus={handleDateFocus}
              onMutationSuccess={invalidatePersistedCache}
              todayPulseToken={todayPulseToken}
            />
          )}
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
                onClick={navLinkClickHandler(monthTodayHref)}
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
            <Link
              className="nav-button"
              href={monthTodayHref}
              aria-label="Today"
              prefetch={true}
              scroll={false}
              onClick={navLinkClickHandler(monthTodayHref)}
            >
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

          {isLoading ? (
            <>
              <BoardSkeleton variant="month" visibleDayCount={skeletonVisibleDayCount} />
              {showExtendedLoadingText ? (
                <div
                  className="board-loading-extended-text"
                  role="status"
                  aria-live="polite"
                >
                  Loading calendar…
                </div>
              ) : null}
            </>
          ) : (
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
              onDateFocus={handleDateFocus}
              onMutationSuccess={invalidatePersistedCache}
              todayPulseToken={todayPulseToken}
            />
          )}
        </>
      )}
    </>
  );
}
