import { readCurrentSnapshot } from "@/lib/store";
import { buildAndPersistSnapshot } from "@/lib/sync";
import {
  classifySnapshot,
  buildDayBoard,
  trimWeekRowsForScheduleList,
  resolveWeekNavigation,
  buildMonthBoard,
  resolveMonthNavigation,
} from "@/lib/view";
import { todayInZone } from "@/lib/time";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { ScheduleView } from "@/components/ScheduleView";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EditorSyncButton } from "@/components/EditorSyncButton";
import { EditorHistoryButton } from "@/components/EditorHistoryButton";
import { EditorTokenBridge } from "@/components/EditorTokenBridge";
import { cookies } from "next/headers";

/**
 * The public availability page.
 *
 * Read-only. Renders from the last known-good snapshot in storage, with a
 * throttled opportunistic refresh path to reduce stale data windows.
 *
 * Snapshot-backed board:
 *
 *     Monday, Apr 21     Available
 *     Tuesday, Apr 22    Booked
 *     ...
 *
 * Rules:
 *   - Monday–Sunday week rows.
 *   - One status per day: Available or Booked.
 *   - Any overlapping blocker-calendar event (incl. tentative) → Booked.
 *
 * Reliability:
 *   - Fail-closed if snapshot is missing or older than hardTtlMinutes.
 */

// Always render on request so the homepage reads the latest snapshot.
export const dynamic = "force-dynamic";
const TODAY_TIMEZONE = "America/New_York";
const AUTO_BOOTSTRAP_BACKOFF_MS = 2 * 60 * 1000;
const AUTO_REFRESH_BACKOFF_MS = 60 * 1000;
const AUTO_REFRESH_MIN_AGE_MINUTES = 3;

let autoBootstrapInFlight: Promise<void> | null = null;
let autoBootstrapBlockedUntilMs = 0;
let autoRefreshInFlight: Promise<void> | null = null;
let autoRefreshBlockedUntilMs = 0;

interface SearchParams {
  start?: string | string[]; // YYYY-MM-DD
  month?: string | string[]; // YYYY-MM
  view?: string | string[]; // list | month
  editor?: string | string[]; // editor token
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveViewMode(value: string | undefined): "list" | "month" {
  return value?.toLowerCase() === "month" ? "month" : "list";
}

function resolveInitialEditorId(
  initialEditorToken: string | undefined,
  env: ReturnType<typeof getConfig>["env"],
): string | null {
  const reqHeaders = new Headers();
  const cookieHeader = cookies().toString();
  if (cookieHeader) {
    reqHeaders.set("cookie", cookieHeader);
  }
  if (initialEditorToken) {
    reqHeaders.set("authorization", `Bearer ${initialEditorToken}`);
  }
  const request = new Request("https://la-schedule-app.local/editor-resolve", {
    headers: reqHeaders,
  });
  const auth = authorizeEditorRequest(request, env);
  return auth.ok ? auth.editorId : null;
}

async function autoBootstrapSnapshotIfNeeded(enabled: boolean): Promise<void> {
  if (!enabled) return;
  const now = Date.now();
  if (now < autoBootstrapBlockedUntilMs) return;

  if (!autoBootstrapInFlight) {
    autoBootstrapInFlight = (async () => {
      const started = Date.now();
      try {
        const result = await buildAndPersistSnapshot();
        const durationMs = Date.now() - started;
        if (result.status === "ok") {
          autoBootstrapBlockedUntilMs = 0;
          console.log(`[bootstrap] snapshot generated in ${durationMs}ms`);
          return;
        }

        autoBootstrapBlockedUntilMs = Date.now() + AUTO_BOOTSTRAP_BACKOFF_MS;
        console.error(
          `[bootstrap] snapshot failed in ${durationMs}ms: ${result.error ?? "unknown error"}`,
          result.erroredCalendarIds?.length
            ? { erroredCalendarIds: result.erroredCalendarIds }
            : undefined,
        );
      } catch (err) {
        autoBootstrapBlockedUntilMs = Date.now() + AUTO_BOOTSTRAP_BACKOFF_MS;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bootstrap] exception: ${msg}`);
      }
    })().finally(() => {
      autoBootstrapInFlight = null;
    });
  }

  await autoBootstrapInFlight;
}

async function autoRefreshSnapshotIfNeeded(enabled: boolean, reason: string): Promise<void> {
  if (!enabled) return;
  const now = Date.now();
  if (now < autoRefreshBlockedUntilMs) return;

  if (!autoRefreshInFlight) {
    autoRefreshInFlight = (async () => {
      const started = Date.now();
      try {
        const result = await buildAndPersistSnapshot();
        const durationMs = Date.now() - started;
        if (result.status === "ok") {
          autoRefreshBlockedUntilMs = 0;
          console.log(`[refresh] snapshot refreshed in ${durationMs}ms (${reason})`);
          return;
        }

        autoRefreshBlockedUntilMs = Date.now() + AUTO_REFRESH_BACKOFF_MS;
        console.error(
          `[refresh] snapshot refresh failed in ${durationMs}ms (${reason}): ${result.error ?? "unknown error"}`,
          result.erroredCalendarIds?.length
            ? { erroredCalendarIds: result.erroredCalendarIds }
            : undefined,
        );
      } catch (err) {
        autoRefreshBlockedUntilMs = Date.now() + AUTO_REFRESH_BACKOFF_MS;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refresh] exception (${reason}): ${msg}`);
      }
    })().finally(() => {
      autoRefreshInFlight = null;
    });
  }

  await autoRefreshInFlight;
}

export default async function AvailabilityPage({
  searchParams = {},
}: {
  searchParams?: SearchParams;
}) {
  const { file, env } = getConfig();
  const viewMode = resolveViewMode(firstParam(searchParams.view));
  const initialEditorToken = firstParam(searchParams.editor);
  const now = Date.now();
  let snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  let state = classifySnapshot(snapshot, now, {
    freshTtlMinutes: file.freshTtlMinutes,
    hardTtlMinutes: file.hardTtlMinutes,
  });

  if (state.status === "unavailable" || !state.snapshot) {
    await autoBootstrapSnapshotIfNeeded(env.AUTO_BOOTSTRAP_ON_UNAVAILABLE);
    snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
    state = classifySnapshot(snapshot, now, {
      freshTtlMinutes: file.freshTtlMinutes,
      hardTtlMinutes: file.hardTtlMinutes,
    });
  }

  const shouldAutoRefresh = !!state.snapshot && (
    state.status === "stale"
    || (state.ageMinutes ?? 0) >= AUTO_REFRESH_MIN_AGE_MINUTES
  );
  if (shouldAutoRefresh) {
    void autoRefreshSnapshotIfNeeded(
      true,
      state.status === "stale"
        ? "snapshot-stale"
        : `${viewMode}-view-age-${Math.floor(state.ageMinutes ?? 0)}m`,
    );
  }

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
  const snapshotData = state.snapshot;
  const windowStartUtc = snapshotData.windowStartUtc;
  const windowEndUtc = snapshotData.windowEndUtc;
  const tz = file.timezone;

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
  const currentWeekStart = resolveWeekNavigation({
    requestedDate: todayKey,
    fallbackDate: todayKey,
    windowStartUtc,
    windowEndUtc,
    timezone: tz,
  }).weekStart;

  const effectiveWeekStart = resolveWeekNavigation({
    requestedDate: clampedRequestedWeek,
    fallbackDate: todayKey,
    windowStartUtc,
    windowEndUtc,
    timezone: tz,
  }).weekStart;
  const weekNav = resolveWeekNavigation({
    requestedDate: effectiveWeekStart,
    fallbackDate: todayKey,
    windowStartUtc,
    windowEndUtc,
    timezone: tz,
  });
  const weekCanGoPrev = weekNav.hasPrev && weekNav.weekStart > currentWeekStart;
  const weekCanGoNext = weekNav.hasNext;

  // List view: selected week + next week. Current selected week hides past rows.
  const rawWeekRows = buildDayBoard({
    snapshot: snapshotData,
    startDate: effectiveWeekStart,
    weeks: 2,
    timezone: tz,
    workdayStartHour: file.workdayStartHour,
    workdayEndHour: file.workdayEndHour,
    nowMs: now,
    todayKey,
  });
  const weekRows = trimWeekRowsForScheduleList({
    weeks: rawWeekRows,
    selectedWeekStart: effectiveWeekStart,
    currentWeekStart,
    todayKey,
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
    windowStartUtc,
    windowEndUtc,
    timezone: tz,
  });
  const monthCanGoPrev = monthNav.hasPrev && monthNav.monthKey > todayMonthKey;
  const titleMain = file.pageTitle.replace(/\s*[—-]\s*Jeff(?:\s+Ulsh)?\s*$/i, "").trim() || "Availability";

  // Month view: full month grid with one status per day.
  const month = buildMonthBoard({
    snapshot: snapshotData,
    month: monthNav.monthKey,
    timezone: tz,
    nowMs: now,
    todayKey,
  });

  const listToggleStart = viewMode === "month" ? `${monthNav.monthKey}-01` : effectiveWeekStart;
  const monthToggleKey = viewMode === "list" ? effectiveWeekStart.slice(0, 7) : monthNav.monthKey;
  const weekPrevHref = `/?view=list&start=${weekNav.prevStart}`;
  const weekNextHref = `/?view=list&start=${weekNav.nextStart}`;
  const monthPrevHref = `/?view=month&month=${monthNav.prevMonth}`;
  const monthNextHref = `/?view=month&month=${monthNav.nextMonth}`;
  const resolvedEditorId = resolveInitialEditorId(initialEditorToken, env);
  const mikeShowWeekendsCookie = cookies().get("la_schedule_mike_show_weekends")?.value;
  const initialShowWeekends = resolvedEditorId === "mike"
    ? mikeShowWeekendsCookie === "1"
    : true;

  return (
    <div className={`page${viewMode === "month" ? " page--month" : ""}`}>
      <EditorTokenBridge />
      <header className="header">
        <h1 className="title">
          <span>{titleMain}</span>
          <span className="title-muted"> · Jeff Ulsh</span>
        </h1>
        <div className="header-actions">
          <div className="header-editor-tools">
            <EditorSyncButton initialEditorToken={initialEditorToken} />
            <EditorHistoryButton initialEditorToken={initialEditorToken} />
          </div>
          <div className="mobile-header-editor-tools" aria-label="Editor tools">
            <EditorSyncButton initialEditorToken={initialEditorToken} />
            <EditorHistoryButton initialEditorToken={initialEditorToken} buttonLabel="History" />
          </div>
          <ThemeToggle />
        </div>
      </header>

      <ScheduleView
        viewMode={viewMode}
        listToggleStart={listToggleStart}
        monthToggleKey={monthToggleKey}
        initialEditorToken={initialEditorToken}
        resolvedEditorId={resolvedEditorId}
        editorCalendarId={env.GOOGLE_CALENDAR_ID}
        overtureCalendarId={env.OVERTURE_CALENDAR_ID}
        todayKey={todayKey}
        todayMonthKey={todayMonthKey}
        weekRows={weekRows}
        weekPrevHref={weekPrevHref}
        weekNextHref={weekNextHref}
        weekCanGoPrev={weekCanGoPrev}
        weekCanGoNext={weekCanGoNext}
        month={month}
        monthPrevHref={monthPrevHref}
        monthNextHref={monthNextHref}
        monthCanGoPrev={monthCanGoPrev}
        monthCanGoNext={monthNav.hasNext}
        initialShowWeekends={initialShowWeekends}
      />

    </div>
  );
}
