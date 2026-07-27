import { getConfig } from "@/lib/config";
import { todayInZone } from "@/lib/time";
import { resolveRequestedMonthKey, resolveRequestedWeekStart } from "@/lib/today-navigation";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffLikeProfile, resolveEditorProfile } from "@/lib/editor-profiles";
import { ScheduleView } from "@/components/ScheduleView";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HeaderTennis } from "@/components/HeaderTennis";
import { EditorSyncButton } from "@/components/EditorSyncButton";
import { EditorHistoryButton } from "@/components/EditorHistoryButton";
import { EditorTokenBridge } from "@/components/EditorTokenBridge";
import { cookies } from "next/headers";
import { Inter } from "next/font/google";
import { DateTime } from "luxon";
import type { BoardWindowPayload } from "@/lib/board-window";
import type { MonthBoardData } from "@/lib/view";

// Header-only font. Subset to latin and a single weight so the
// payload stays small. `display: swap` so the fallback paints first
// and Inter replaces it the moment it's available — no FOIT.
const headerFont = Inter({
  subsets: ["latin"],
  weight: ["600"],
  display: "swap",
});

/**
 * The public availability page — static-shell flavor.
 *
 * SSR work is intentionally minimal: cookies, searchParams, and a synthetic
 * skeleton `BoardWindowPayload`. NO snapshot read, NO board build, NO Google
 * call. The browser hydrates ScheduleView, which restores the freshest
 * payload from localStorage (if any) and immediately fetches a fresh one
 * from /api/board/window. Webhooks + scheduled-sync keep the snapshot fresh
 * server-side; mutation routes use strong-consistency reads for correctness.
 */

// Reading cookies()/searchParams forces dynamic rendering; force-dynamic is
// kept for clarity. The SSR cost is now O(date math), not O(snapshot+build).
export const dynamic = "force-dynamic";

// Sentinel `generatedAtUtc` for the synthetic SSR payload. Any real cached
// payload's timestamp is strictly newer, so `pickFreshestForView` always
// picks the cache over the skeleton — that's what enables instant repeat-
// visit paint. The `Synthetic` flag below also stops the skeleton from
// polluting the cache.
const SYNTHETIC_GENERATED_AT_UTC = "1970-01-01T00:00:00.000Z";

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

function emptyMonthBoardData(monthKey: string): MonthBoardData {
  return { monthKey, label: "", weeks: [] };
}

function buildSyntheticInitialPayload(opts: {
  viewMode: "list" | "month";
  weekStart: string;
  monthKey: string;
  todayKey: string;
  todayMonthKey: string;
  resolvedEditorId: string | null;
  timezone: string;
}): BoardWindowPayload {
  const weekStartDate = DateTime.fromISO(opts.weekStart, { zone: opts.timezone });
  const weekPrev = weekStartDate.isValid
    ? weekStartDate.minus({ weeks: 1 }).toFormat("yyyy-LL-dd")
    : opts.weekStart;
  const weekNext = weekStartDate.isValid
    ? weekStartDate.plus({ weeks: 1 }).toFormat("yyyy-LL-dd")
    : opts.weekStart;
  const monthStart = DateTime.fromFormat(opts.monthKey, "yyyy-LL", { zone: opts.timezone });
  const monthPrev = monthStart.isValid
    ? monthStart.minus({ months: 1 }).toFormat("yyyy-LL")
    : opts.monthKey;
  const monthNext = monthStart.isValid
    ? monthStart.plus({ months: 1 }).toFormat("yyyy-LL")
    : opts.monthKey;

  return {
    status: "ok",
    snapshotStatus: "stale",
    generatedAtUtc: SYNTHETIC_GENERATED_AT_UTC,
    snapshotWindowStartUtc: SYNTHETIC_GENERATED_AT_UTC,
    snapshotWindowEndUtc: SYNTHETIC_GENERATED_AT_UTC,
    timezone: opts.timezone,
    resolvedEditorId: opts.resolvedEditorId,
    todayKey: opts.todayKey,
    todayMonthKey: opts.todayMonthKey,
    selected: {
      view: opts.viewMode,
      weekStart: opts.weekStart,
      monthKey: opts.monthKey,
      weekNav: {
        weekStart: opts.weekStart,
        prevStart: weekPrev,
        nextStart: weekNext,
        hasPrev: false,
        hasNext: true,
        canGoPrev: false,
        canGoNext: true,
      },
      monthNav: {
        monthKey: opts.monthKey,
        prevMonth: monthPrev,
        nextMonth: monthNext,
        hasPrev: false,
        hasNext: true,
        canGoPrev: false,
        canGoNext: true,
      },
    },
    selectedBoards: {
      weekRows: [],
      month: emptyMonthBoardData(opts.monthKey),
    },
    weekWindow: {
      startWeek: opts.weekStart,
      endWeek: opts.weekStart,
      weekCount: 0,
      weeks: [],
    },
    monthWindow: {
      startMonth: opts.monthKey,
      endMonth: opts.monthKey,
      monthCount: 0,
      months: [],
    },
  };
}

export default async function AvailabilityPage({
  searchParams = {},
}: {
  searchParams?: SearchParams;
}) {
  // [perf] keep this lightweight log so we can confirm the SSR is fast.
  const perfPageStartedAt = Date.now();
  const { file, env } = getConfig();
  const viewMode = resolveViewMode(firstParam(searchParams.view));
  const initialEditorToken = firstParam(searchParams.editor);
  const now = Date.now();
  const tz = file.timezone;
  const todayKey = todayInZone(tz, now);
  const todayMonthKey = todayKey.slice(0, 7);

  // Anchor the requested week/month from searchParams (or default to today)
  // without touching the snapshot. Window-clamping happens client-side once
  // /api/board/window returns the real boundaries.
  const weekStart = resolveRequestedWeekStart({
    requestedWeekParam: firstParam(searchParams.start),
    todayKey,
    timezone: tz,
  });
  const monthKey = resolveRequestedMonthKey({
    requestedMonthParam: firstParam(searchParams.month),
    todayMonthKey,
  });

  const resolvedEditorId = resolveInitialEditorId(initialEditorToken, env);
  const isJeffEditor = resolvedEditorId !== null && isJeffLikeProfile(resolveEditorProfile(resolvedEditorId));
  const mikeShowWeekendsCookie = cookies().get("la_schedule_mike_show_weekends")?.value;
  const initialShowWeekends = resolvedEditorId === "mike"
    ? mikeShowWeekendsCookie === "1"
    : true;

  const initialBoardWindowPayload = buildSyntheticInitialPayload({
    viewMode,
    weekStart,
    monthKey,
    todayKey,
    todayMonthKey,
    resolvedEditorId,
    timezone: tz,
  });

  const listToggleStart = viewMode === "month" ? `${monthKey}-01` : weekStart;
  const monthToggleKey = viewMode === "list" ? weekStart.slice(0, 7) : monthKey;
  const weekPrevHref = `/?view=list&start=${initialBoardWindowPayload.selected.weekNav.prevStart}`;
  const weekNextHref = `/?view=list&start=${initialBoardWindowPayload.selected.weekNav.nextStart}`;
  const monthPrevHref = `/?view=month&month=${initialBoardWindowPayload.selected.monthNav.prevMonth}`;
  const monthNextHref = `/?view=month&month=${initialBoardWindowPayload.selected.monthNav.nextMonth}`;

  const perfPageTotalMs = Date.now() - perfPageStartedAt;
  console.info(
    `[perf] page total ms readSnapshot=0 buildWeek=0 buildMonth=0 buildWindow=0 total=${perfPageTotalMs} view=${viewMode} shell=1`,
  );

  return (
    <div className={`page${viewMode === "month" ? " page--month" : ""}`}>
      <EditorTokenBridge />
      <header className="header">
        <div className="header-title-row">
          <h1
            className={`title title--premium ${headerFont.className}`}
            aria-label="Jeff Ulsh"
          >
            {Array.from("Jeff Ulsh").map((ch, i) => (
              <span
                key={i}
                className="title-char"
                style={{ animationDelay: `${i * 90}ms` }}
                aria-hidden="true"
              >
                {ch === " " ? " " : ch}
              </span>
            ))}
          </h1>
          <HeaderTennis />
        </div>
        <div className="header-actions">
          <div className="header-editor-tools">
            <EditorSyncButton initialEditorToken={initialEditorToken} />
            <EditorHistoryButton initialEditorToken={initialEditorToken} />
            {isJeffEditor ? (
              <a href="/admin/invoices" className="header-invoices-link">Invoices</a>
            ) : null}
          </div>
          <div className="mobile-header-editor-tools" aria-label="Editor tools">
            <EditorSyncButton initialEditorToken={initialEditorToken} />
            <EditorHistoryButton initialEditorToken={initialEditorToken} buttonLabel="History" />
            {isJeffEditor ? (
              <a href="/admin/invoices" className="header-invoices-link">Invoices</a>
            ) : null}
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
        weekRows={[]}
        weekPrevHref={weekPrevHref}
        weekNextHref={weekNextHref}
        weekCanGoPrev={false}
        weekCanGoNext={true}
        month={emptyMonthBoardData(monthKey)}
        monthPrevHref={monthPrevHref}
        monthNextHref={monthNextHref}
        monthCanGoPrev={false}
        monthCanGoNext={true}
        initialShowWeekends={initialShowWeekends}
        initialBoardWindowPayload={initialBoardWindowPayload}
        initialPayloadIsSynthetic={true}
      />
    </div>
  );
}
