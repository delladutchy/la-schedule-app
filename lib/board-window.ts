import { DateTime } from "luxon";
import type { EnvConfig, FileConfig } from "./config";
import type { DayEventDetail } from "./types";
import type { MonthBoardData, MonthEventBarDetail, WeekGroup } from "./view";
import {
  buildDayBoard,
  buildMonthBoard,
  resolveMonthNavigation,
  resolveWeekNavigation,
  trimWeekRowsForScheduleList,
} from "./view";
import { todayInZone } from "./time";
import { authorizeEditorRequest } from "./editor-auth";
import { sanitizeEditorToken } from "./editor-session";
import { canProfileManageEvent, resolveEditorProfile, type EditorProfile } from "./editor-profiles";

const TODAY_TIMEZONE = "America/New_York";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

type ViewMode = "list" | "month";

interface CalendarScopeEnv {
  GOOGLE_CALENDAR_ID: string;
  OVERTURE_CALENDAR_ID?: string;
}

interface DetailAccessContext {
  editorId: string | null;
  profile: EditorProfile | null;
  env: CalendarScopeEnv;
}

export interface BoardWindowQuery {
  viewMode: ViewMode;
  requestedWeek: string | null;
  requestedMonth: string | null;
  weeksBefore: number;
  weeksAfter: number;
  monthsBefore: number;
  monthsAfter: number;
}

export interface BoardWindowPayload {
  status: "ok";
  snapshotStatus: "ok" | "stale";
  generatedAtUtc: string;
  snapshotWindowStartUtc: string;
  snapshotWindowEndUtc: string;
  timezone: string;
  resolvedEditorId: string | null;
  todayKey: string;
  todayMonthKey: string;
  selected: {
    view: ViewMode;
    weekStart: string;
    monthKey: string;
    weekNav: {
      weekStart: string;
      prevStart: string;
      nextStart: string;
      hasPrev: boolean;
      hasNext: boolean;
      canGoPrev: boolean;
      canGoNext: boolean;
    };
    monthNav: {
      monthKey: string;
      prevMonth: string;
      nextMonth: string;
      hasPrev: boolean;
      hasNext: boolean;
      canGoPrev: boolean;
      canGoNext: boolean;
    };
  };
  selectedBoards: {
    weekRows: WeekGroup[];
    month: MonthBoardData;
  };
  weekWindow: {
    startWeek: string;
    endWeek: string;
    weekCount: number;
    weeks: WeekGroup[];
  };
  monthWindow: {
    startMonth: string;
    endMonth: string;
    monthCount: number;
    months: MonthBoardData[];
  };
}

function firstParam(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveViewMode(value: string | undefined): ViewMode {
  return value?.toLowerCase() === "month" ? "month" : "list";
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeEditorId(editorId: string | null): string | null {
  const normalized = editorId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeOwnerEditor(ownerEditor: string | undefined): string | undefined {
  const normalized = ownerEditor?.trim().toLowerCase();
  if (!normalized) return undefined;
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized) ? normalized : undefined;
}

function canEditorManageDetail(
  detail: { calendarId?: string; ownerEditor?: string },
  access: DetailAccessContext,
): boolean {
  if (!access.profile || !access.editorId) return false;
  return canProfileManageEvent(
    access.profile,
    {
      calendarId: detail.calendarId,
      ownerEditor: normalizeOwnerEditor(detail.ownerEditor),
    },
    access.env,
  );
}

function canEditorViewNotes(
  detail: { calendarId?: string; ownerEditor?: string },
  access: DetailAccessContext,
): boolean {
  if (!access.editorId) return false;
  if (access.editorId === "jeff" || access.editorId === "legacy") return true;
  return canEditorManageDetail(detail, access);
}

function sanitizeDayEventDetail(
  detail: DayEventDetail,
  access: DetailAccessContext,
): DayEventDetail {
  const canManage = canEditorManageDetail(detail, access);
  const canViewNotes = canEditorViewNotes(detail, access);
  return {
    summary: detail.summary,
    startUtc: detail.startUtc,
    endUtc: detail.endUtc,
    ...(detail.startDate ? { startDate: detail.startDate } : {}),
    ...(detail.endDateInclusive ? { endDateInclusive: detail.endDateInclusive } : {}),
    ...(canManage && detail.eventId ? { eventId: detail.eventId } : {}),
    ...(canViewNotes && detail.description ? { description: detail.description } : {}),
    dateRangeLabel: detail.dateRangeLabel,
    ...(detail.timeRangeLabel ? { timeRangeLabel: detail.timeRangeLabel } : {}),
    ...(detail.calendarId ? { calendarId: detail.calendarId } : {}),
    ...(detail.displayMode ? { displayMode: detail.displayMode } : {}),
  };
}

function sanitizeMonthEventBarDetail(
  detail: MonthEventBarDetail,
  access: DetailAccessContext,
): MonthEventBarDetail {
  const canManage = canEditorManageDetail(detail, access);
  const canViewNotes = canEditorViewNotes(detail, access);
  return {
    summary: detail.summary,
    ...(detail.jobNumber ? { jobNumber: detail.jobNumber } : {}),
    ...(canManage && detail.eventId ? { eventId: detail.eventId } : {}),
    ...(canViewNotes && detail.description ? { description: detail.description } : {}),
    ...(detail.startUtc ? { startUtc: detail.startUtc } : {}),
    ...(detail.endUtc ? { endUtc: detail.endUtc } : {}),
    ...(detail.startDate ? { startDate: detail.startDate } : {}),
    ...(detail.endDateInclusive ? { endDateInclusive: detail.endDateInclusive } : {}),
    ...(detail.calendarId ? { calendarId: detail.calendarId } : {}),
    ...(detail.dateRangeLabel ? { dateRangeLabel: detail.dateRangeLabel } : {}),
    ...(detail.timeRangeLabel ? { timeRangeLabel: detail.timeRangeLabel } : {}),
    ...(detail.displayMode ? { displayMode: detail.displayMode } : {}),
  };
}

function sanitizeWeekRows(
  weekRows: WeekGroup[],
  access: DetailAccessContext,
): WeekGroup[] {
  return weekRows.map((week) => ({
    ...week,
    days: week.days.map((day) => ({
      ...day,
      ...(day.eventDetails
        ? {
            eventDetails: day.eventDetails.map((detail) =>
              sanitizeDayEventDetail(detail, access)),
          }
        : {}),
    })),
  }));
}

function sanitizeMonthBoard(
  month: MonthBoardData,
  access: DetailAccessContext,
): MonthBoardData {
  return {
    ...month,
    weeks: month.weeks.map((week) => ({
      ...week,
      days: week.days.map((day) => ({
        ...day,
        ...(day.eventDetails
          ? {
              eventDetails: day.eventDetails.map((detail) =>
                sanitizeDayEventDetail(detail, access)),
            }
          : {}),
      })),
      bars: week.bars.map((bar) => ({
        ...bar,
        details: bar.details.map((detail) =>
          sanitizeMonthEventBarDetail(detail, access)),
      })),
    })),
  };
}

export function parseBoardWindowQuery(url: URL): BoardWindowQuery {
  const centerDate = firstParam(url.searchParams.get("center"));
  const startParam = firstParam(url.searchParams.get("start"));
  const monthParam = firstParam(url.searchParams.get("month"));
  const requestedWeek = startParam && DATE_KEY_PATTERN.test(startParam)
    ? startParam
    : centerDate && DATE_KEY_PATTERN.test(centerDate)
      ? centerDate
      : null;
  const requestedMonth = monthParam && MONTH_KEY_PATTERN.test(monthParam)
    ? monthParam
    : centerDate && DATE_KEY_PATTERN.test(centerDate)
      ? centerDate.slice(0, 7)
      : null;

  return {
    viewMode: resolveViewMode(firstParam(url.searchParams.get("view"))),
    requestedWeek,
    requestedMonth,
    weeksBefore: parseBoundedInt(firstParam(url.searchParams.get("weeksBefore")), 0, 0, 8),
    weeksAfter: parseBoundedInt(firstParam(url.searchParams.get("weeksAfter")), 8, 1, 16),
    monthsBefore: parseBoundedInt(firstParam(url.searchParams.get("monthsBefore")), 0, 0, 4),
    monthsAfter: parseBoundedInt(firstParam(url.searchParams.get("monthsAfter")), 4, 1, 8),
  };
}

export function resolveBoardRequestEditorId(
  req: Request,
  env: Pick<EnvConfig, "EDITOR_TOKEN" | "EDITOR_TOKENS_JSON">,
): string | null {
  const url = new URL(req.url);
  const editorToken = sanitizeEditorToken(url.searchParams.get("editor"));
  if (!editorToken) {
    const auth = authorizeEditorRequest(req, env);
    return auth.ok ? auth.editorId : null;
  }

  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${editorToken}`);
  const tokenRequest = new Request(req.url, { headers });
  const auth = authorizeEditorRequest(tokenRequest, env);
  return auth.ok ? auth.editorId : null;
}

export function buildSanitizedBoardWindowPayload(opts: {
  snapshot: Parameters<typeof buildDayBoard>[0]["snapshot"];
  snapshotStatus: "ok" | "stale";
  file: Pick<FileConfig,
    | "timezone"
    | "workdayStartHour"
    | "workdayEndHour"
  >;
  env: Pick<EnvConfig, "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID">;
  query: BoardWindowQuery;
  resolvedEditorId: string | null;
  nowMs?: number;
}): BoardWindowPayload {
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.file.timezone;
  const normalizedEditorId = normalizeEditorId(opts.resolvedEditorId);
  const editorProfile = normalizedEditorId ? resolveEditorProfile(normalizedEditorId) : null;
  const access: DetailAccessContext = {
    editorId: normalizedEditorId,
    profile: editorProfile,
    env: {
      GOOGLE_CALENDAR_ID: opts.env.GOOGLE_CALENDAR_ID,
      OVERTURE_CALENDAR_ID: opts.env.OVERTURE_CALENDAR_ID,
    },
  };

  const todayKey = todayInZone(TODAY_TIMEZONE, nowMs);
  const todayMonthKey = todayKey.slice(0, 7);

  const requestedWeek = opts.query.requestedWeek ?? todayKey;
  const clampedRequestedWeek = requestedWeek < todayKey ? todayKey : requestedWeek;
  const currentWeekStart = resolveWeekNavigation({
    requestedDate: todayKey,
    fallbackDate: todayKey,
    windowStartUtc: opts.snapshot.windowStartUtc,
    windowEndUtc: opts.snapshot.windowEndUtc,
    timezone: tz,
  }).weekStart;
  const selectedWeekNav = resolveWeekNavigation({
    requestedDate: clampedRequestedWeek,
    fallbackDate: todayKey,
    windowStartUtc: opts.snapshot.windowStartUtc,
    windowEndUtc: opts.snapshot.windowEndUtc,
    timezone: tz,
  });
  const selectedWeekStart = selectedWeekNav.weekStart;
  const selectedWeekCanGoPrev = selectedWeekNav.hasPrev
    && selectedWeekNav.weekStart > currentWeekStart;

  const selectedWeekRowsRaw = buildDayBoard({
    snapshot: opts.snapshot,
    startDate: selectedWeekStart,
    weeks: 2,
    timezone: tz,
    workdayStartHour: opts.file.workdayStartHour,
    workdayEndHour: opts.file.workdayEndHour,
    nowMs,
    todayKey,
  });
  const selectedWeekRows = sanitizeWeekRows(
    trimWeekRowsForScheduleList({
      weeks: selectedWeekRowsRaw,
      selectedWeekStart,
      currentWeekStart,
      todayKey,
    }),
    access,
  );

  const requestedMonth = opts.query.requestedMonth ?? todayMonthKey;
  const clampedRequestedMonth = requestedMonth < todayMonthKey ? todayMonthKey : requestedMonth;
  const selectedMonthNav = resolveMonthNavigation({
    requestedMonth: clampedRequestedMonth,
    fallbackDate: todayKey,
    windowStartUtc: opts.snapshot.windowStartUtc,
    windowEndUtc: opts.snapshot.windowEndUtc,
    timezone: tz,
  });
  const selectedMonthCanGoPrev = selectedMonthNav.hasPrev
    && selectedMonthNav.monthKey > todayMonthKey;
  const selectedMonth = sanitizeMonthBoard(
    buildMonthBoard({
      snapshot: opts.snapshot,
      month: selectedMonthNav.monthKey,
      timezone: tz,
      nowMs,
      todayKey,
    }),
    access,
  );

  const selectedWeekStartDate = DateTime.fromISO(selectedWeekStart, { zone: tz }).startOf("week");
  const weekWindowStartDate = selectedWeekStartDate
    .minus({ weeks: opts.query.weeksBefore });
  const clampedWeekWindowStartDate = weekWindowStartDate < DateTime.fromISO(currentWeekStart, { zone: tz })
    ? DateTime.fromISO(currentWeekStart, { zone: tz })
    : weekWindowStartDate;
  const weekWindowStart = clampedWeekWindowStartDate.toFormat("yyyy-LL-dd");
  const alignedWeeksBefore = Math.round(
    selectedWeekStartDate.diff(clampedWeekWindowStartDate, "weeks").weeks,
  );
  const weekWindowCount = opts.query.weeksBefore + opts.query.weeksAfter + 1;
  const alignedWeekWindowCount = alignedWeeksBefore + opts.query.weeksAfter + 1;
  const weekWindowRows: WeekGroup[] = [];
  for (let i = 0; i < alignedWeekWindowCount; i += 1) {
    const weekStart = clampedWeekWindowStartDate.plus({ weeks: i });
    const weekStartKey = weekStart.toFormat("yyyy-LL-dd");
    const weekRows = buildDayBoard({
      snapshot: opts.snapshot,
      startDate: weekStartKey,
      weeks: 1,
      timezone: tz,
      workdayStartHour: opts.file.workdayStartHour,
      workdayEndHour: opts.file.workdayEndHour,
      nowMs,
      todayKey,
    });
    if (weekRows[0]) {
      weekWindowRows.push(sanitizeWeekRows(weekRows, access)[0] as WeekGroup);
    }
  }
  const weekWindowEnd = clampedWeekWindowStartDate
    .plus({ weeks: alignedWeekWindowCount - 1 })
    .toFormat("yyyy-LL-dd");

  const currentMonthStart = DateTime.fromFormat(todayMonthKey, "yyyy-LL", { zone: tz }).startOf("month");
  const selectedMonthStart = DateTime.fromFormat(selectedMonthNav.monthKey, "yyyy-LL", { zone: tz }).startOf("month");
  const monthWindowStartDate = selectedMonthStart.minus({ months: opts.query.monthsBefore });
  const clampedMonthWindowStartDate = monthWindowStartDate < currentMonthStart
    ? currentMonthStart
    : monthWindowStartDate;
  const alignedMonthsBefore = Math.round(
    selectedMonthStart.diff(clampedMonthWindowStartDate, "months").months,
  );
  const monthWindowCount = opts.query.monthsBefore + opts.query.monthsAfter + 1;
  const alignedMonthWindowCount = alignedMonthsBefore + opts.query.monthsAfter + 1;
  const monthWindowBoards: MonthBoardData[] = [];
  for (let i = 0; i < alignedMonthWindowCount; i += 1) {
    const monthKey = clampedMonthWindowStartDate.plus({ months: i }).toFormat("yyyy-LL");
    monthWindowBoards.push(
      sanitizeMonthBoard(
        buildMonthBoard({
          snapshot: opts.snapshot,
          month: monthKey,
          timezone: tz,
          nowMs,
          todayKey,
        }),
        access,
      ),
    );
  }
  const monthWindowStart = clampedMonthWindowStartDate.toFormat("yyyy-LL");
  const monthWindowEnd = clampedMonthWindowStartDate
    .plus({ months: alignedMonthWindowCount - 1 })
    .toFormat("yyyy-LL");

  // keep variable references stable for payload consumers
  void weekWindowCount;
  void monthWindowCount;

  return {
    status: "ok",
    snapshotStatus: opts.snapshotStatus,
    generatedAtUtc: opts.snapshot.generatedAtUtc,
    snapshotWindowStartUtc: opts.snapshot.windowStartUtc,
    snapshotWindowEndUtc: opts.snapshot.windowEndUtc,
    timezone: tz,
    resolvedEditorId: normalizedEditorId,
    todayKey,
    todayMonthKey,
    selected: {
      view: opts.query.viewMode,
      weekStart: selectedWeekStart,
      monthKey: selectedMonthNav.monthKey,
      weekNav: {
        weekStart: selectedWeekNav.weekStart,
        prevStart: selectedWeekNav.prevStart,
        nextStart: selectedWeekNav.nextStart,
        hasPrev: selectedWeekNav.hasPrev,
        hasNext: selectedWeekNav.hasNext,
        canGoPrev: selectedWeekCanGoPrev,
        canGoNext: selectedWeekNav.hasNext,
      },
      monthNav: {
        monthKey: selectedMonthNav.monthKey,
        prevMonth: selectedMonthNav.prevMonth,
        nextMonth: selectedMonthNav.nextMonth,
        hasPrev: selectedMonthNav.hasPrev,
        hasNext: selectedMonthNav.hasNext,
        canGoPrev: selectedMonthCanGoPrev,
        canGoNext: selectedMonthNav.hasNext,
      },
    },
    selectedBoards: {
      weekRows: selectedWeekRows,
      month: selectedMonth,
    },
    weekWindow: {
      startWeek: weekWindowStart,
      endWeek: weekWindowEnd,
      weekCount: weekWindowRows.length,
      weeks: weekWindowRows,
    },
    monthWindow: {
      startMonth: monthWindowStart,
      endMonth: monthWindowEnd,
      monthCount: monthWindowBoards.length,
      months: monthWindowBoards,
    },
  };
}
