"use client";

import { useEffect, useRef, useState, type TouchEventHandler } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import {
  buildWeekRenderRows,
  type BookedDaySummary,
  type WeekGroup,
} from "@/lib/view";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";
import {
  buildGigDayDetailsForRange,
  buildGigDescription,
  buildLaJobSummary,
  enumerateIsoDatesInRange,
  mergeGigDescriptionWithDailyDetailsBlock,
  parseGigDescription,
  parseLaJobSummary,
  resolveParsedGigDetailForDate,
} from "@/lib/gigs";
import { CALL_TIME_OPTIONS, isCallTimeOption } from "@/lib/call-time-options";

interface Props {
  weeks: WeekGroup[];
  weekendTodayLabel?: string;
  initialEditorToken?: string;
  initialResolvedEditorId?: string | null;
  editorCalendarId?: string;
  overtureCalendarId?: string;
  prevHref?: string;
  nextHref?: string;
  canGoPrev?: boolean;
  canGoNext?: boolean;
  showWeekends?: boolean;
  onNavigate?: (href: string) => void;
  onDateFocus?: (date: string) => void;
  onMutationSuccess?: () => void;
  todayPulseToken?: number;
}

const STAGED_LOADING_COPY: ReadonlyArray<{ delay: number; text: string }> = [
  { delay: 0, text: "Updating calendar…" },
  { delay: 700, text: "Confirming with Google…" },
  { delay: 1800, text: "Refreshing schedule…" },
  { delay: 5000, text: "Google Calendar is taking a little longer…" },
];

const GROUP_SAME_JOB_NUMBERS_ENABLED = process.env.NEXT_PUBLIC_GROUP_SAME_JOB_NUMBERS === "true";

function useStagedLoadingCopy(isActive: boolean): string {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setStage(0);
      return undefined;
    }
    setStage(0);
    const timers = STAGED_LOADING_COPY.slice(1).map((entry, index) =>
      window.setTimeout(() => setStage(index + 1), entry.delay),
    );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [isActive]);

  return STAGED_LOADING_COPY[stage]?.text ?? STAGED_LOADING_COPY[0]!.text;
}

type BookedLabel = BookedDaySummary;

interface ActiveDetailPanel {
  rowKey: string;
  selectedDate: string;
  header: string;
  headerJobNumber?: string;
  details: BookedLabel["details"];
}

interface ActiveBookingPanel {
  mode: "create" | "edit";
  eventId?: string;
  date: string;
  bookingMode: "la" | "overture";
}

interface BookingDayOverride {
  callTimeOption: string;
  callTimeOther: string;
  notes: string;
}

type BookingDayOverrideMap = Record<string, BookingDayOverride>;

function stripJobPrefix(summary: string, jobNumber?: string): string {
  if (!jobNumber) return summary;
  const digits = jobNumber.replace(/\D/g, "");
  if (!digits) return summary;
  const stripped = summary
    .replace(new RegExp(`^\\s*LA\\s*#?\\s*${digits}\\b[\\s\\-–—:|]*`, "i"), "")
    .trim();
  return stripped.length > 0 ? stripped : summary;
}

function normalizeEditorId(rawEditorId: string | null): string | null {
  const normalized = rawEditorId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function resolveBookingModeFromDetail(
  detail: BookedLabel["details"][number],
  isMikeEditor: boolean,
  overtureCalendarId?: string,
): "la" | "overture" {
  if (isMikeEditor) return "overture";
  if (overtureCalendarId && detail.calendarId === overtureCalendarId) return "overture";
  return "la";
}

function isOvertureDetail(
  detail: BookedLabel["details"][number],
  overtureCalendarId?: string,
): boolean {
  const summary = detail.summary.trim().toLowerCase();
  const matchesSummary = summary === "overture";
  const matchesCalendar = !!overtureCalendarId && detail.calendarId === overtureCalendarId;
  return matchesSummary || matchesCalendar;
}

function isLaDetail(
  detail: BookedLabel["details"][number],
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  if ((detail.displayMode ?? "details") !== "details") return false;
  if (isOvertureDetail(detail, overtureCalendarId)) return false;
  if (laCalendarId && detail.calendarId === laCalendarId) return true;
  return /^LA#\d+/i.test(detail.summary.trim());
}

function canViewDetailNotes(
  detail: BookedLabel["details"][number],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  const editorId = normalizeEditorId(resolvedEditorId);
  if (!editorId) return false;
  if (editorId === "jeff" || editorId === "legacy") return true;
  return canManageDetailForEditor(
    detail,
    editorId,
    laCalendarId,
    overtureCalendarId,
  );
}

function canManageDetailForEditor(
  detail: BookedLabel["details"][number],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  if ((detail.displayMode ?? "details") !== "details") return false;
  if (!detail.eventId) return false;

  const editorId = normalizeEditorId(resolvedEditorId);
  if (!editorId) return true;

  const calendarId = detail.calendarId;
  const ownerEditor = normalizeEditorId(detail.ownerEditor ?? null);

  if (editorId === "jeff" || editorId === "legacy") return true;

  if (editorId === "dave") {
    return !!laCalendarId && calendarId === laCalendarId;
  }

  if (editorId === "milos") {
    return !!laCalendarId
      && calendarId === laCalendarId
      && ownerEditor === editorId;
  }

  if (editorId === "mike") {
    return !!overtureCalendarId
      && calendarId === overtureCalendarId;
  }

  return true;
}

function findEditableDetail(
  details: BookedLabel["details"],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): BookedLabel["details"][number] | null {
  return details.find((detail) =>
    canManageDetailForEditor(detail, resolvedEditorId, laCalendarId, overtureCalendarId)) ?? null;
}

function formatCompactDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc, LLL d");
}

function formatShortDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("LLL d");
}

function formatDayAbbrev(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc");
}

function formatPopupDateRange(startDate: string, endDate: string): string {
  const start = DateTime.fromISO(startDate, { zone: "utc" });
  const end = DateTime.fromISO(endDate, { zone: "utc" });
  if (!start.isValid || !end.isValid || end < start) return `${startDate} – ${endDate}`;
  if (start.hasSame(end, "day")) return start.toFormat("LLL d");
  if (start.year === end.year && start.month === end.month) {
    return `${start.toFormat("LLL d")}–${end.toFormat("d")}`;
  }
  if (start.year === end.year) {
    return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
  }
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}

interface BookingCalendarDay {
  isoDate: string;
  dayNumber: string;
  isCurrentMonth: boolean;
  isBeforeStart: boolean;
}

function buildBookingCalendarDays(startIsoDate: string, monthKey: string): {
  monthLabel: string;
  days: BookingCalendarDay[];
} {
  const start = DateTime.fromISO(startIsoDate, { zone: "utc" });
  const viewedMonth = DateTime.fromFormat(monthKey, "yyyy-LL", { zone: "utc" });
  const monthStart = (viewedMonth.isValid ? viewedMonth : start).startOf("month");
  const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
  const viewedMonthEnd = monthStart.endOf("month");
  const gridEnd = viewedMonthEnd.plus({ days: 7 - viewedMonthEnd.weekday });

  const days: BookingCalendarDay[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const isoDate = cursor.toFormat("yyyy-LL-dd");
    days.push({
      isoDate,
      dayNumber: cursor.toFormat("d"),
      isCurrentMonth: cursor.month === monthStart.month && cursor.year === monthStart.year,
      isBeforeStart: isoDate < startIsoDate,
    });
    cursor = cursor.plus({ days: 1 });
  }

  return {
    monthLabel: monthStart.toFormat("LLLL yyyy"),
    days,
  };
}

export function filterWeekRowsByWeekendVisibility(
  weeks: WeekGroup[],
  hideWeekends: boolean,
): WeekGroup[] {
  if (!hideWeekends) return weeks;
  return weeks
    .map((week) => ({
      ...week,
      days: week.days.filter((day) => !day.isWeekend),
    }))
    .filter((week) => week.days.length > 0);
}

export function buildBookedDayInlineMetaForDate(
  bookedLabel: BookedLabel,
  date: string,
): string | null {
  const values = bookedLabel.details
    .map((detail) => {
      const parsed = parseGigDescription(detail.description);
      const resolved = resolveParsedGigDetailForDate(parsed, date);
      return resolved.startTime?.trim();
    })
    .filter((value): value is string => !!value && value.length > 0);
  if (values.length === 0) return null;
  const deduped = [...new Set(values)];
  const [first, ...rest] = deduped;
  if (!first) return null;
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}

export function buildWeekBookedBadgeDisplay(opts: {
  bookedLabel: BookedLabel;
  connectorPart: "none" | "start" | "middle" | "end";
}): {
  primary: string | null;
  isSubtle?: boolean;
} {
  const label = opts.bookedLabel.label?.trim() ?? "";
  const hasUsefulLabel = label.length > 0 && label.toLowerCase() !== "busy";

  if (opts.connectorPart === "middle" || opts.connectorPart === "end") {
    if (hasUsefulLabel) {
      return { primary: "Booked", isSubtle: true };
    }
    return {
      primary: label.length > 0 ? label : "Busy",
    };
  }

  return {
    primary: label.length > 0 ? label : "Busy",
  };
}

function detailIncludesDate(detail: BookedLabel["details"][number], date: string): boolean {
  const startDate = detail.startDate ?? detail.startUtc?.slice(0, 10);
  const endDate = detail.endDateInclusive ?? detail.endUtc?.slice(0, 10) ?? startDate;
  if (!startDate || !endDate) return false;
  return date >= startDate && date <= endDate;
}

export function resolveSelectedDayPopupMeta(
  detail: BookedLabel["details"][number],
  selectedDate: string,
): {
  selectedStartTime: string | null;
  selectedDayNotes: string | null;
  globalJobNotes: string | null;
} {
  const parsed = parseGigDescription(detail.description);
  const selected = resolveParsedGigDetailForDate(parsed, selectedDate);
  const selectedNotes = parsed.dayDetails?.[selectedDate]?.notes?.trim() || null;
  const globalNotes = parsed.jobNotes?.trim() || null;
  return {
    selectedStartTime: selected.startTime?.trim() || null,
    selectedDayNotes: selectedNotes,
    globalJobNotes: globalNotes || null,
  };
}

/**
 * Employer-facing day board.
 *
 * Each weekday renders as a single row: date on the left, status badge
 * on the right. No times, no slots, no grid. Just "Available" / "Booked".
 */
export function DayBoard({
  weeks,
  weekendTodayLabel,
  initialEditorToken,
  initialResolvedEditorId = null,
  editorCalendarId,
  overtureCalendarId,
  prevHref,
  nextHref,
  canGoPrev = false,
  canGoNext = false,
  showWeekends = true,
  onNavigate,
  onDateFocus,
  onMutationSuccess,
  todayPulseToken = 0,
}: Props) {
  const router = useRouter();
  const [todayPulseActive, setTodayPulseActive] = useState(false);
  useEffect(() => {
    if (todayPulseToken === 0) return;
    setTodayPulseActive(true);
    const id = window.setTimeout(() => setTodayPulseActive(false), 1100);
    return () => window.clearTimeout(id);
  }, [todayPulseToken]);
  const swipeRef = useRef<{
    tracking: boolean;
    startX: number;
    startY: number;
    moved: boolean;
  }>({
    tracking: false,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const [activeDetailPanel, setActiveDetailPanel] = useState<ActiveDetailPanel | null>(null);
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [resolvedEditorId, setResolvedEditorId] = useState<string | null>(initialResolvedEditorId);
  const [activeBookingPanel, setActiveBookingPanel] = useState<ActiveBookingPanel | null>(null);
  const [bookingLaNumber, setBookingLaNumber] = useState("");
  const [bookingJobName, setBookingJobName] = useState("");
  const [bookingEndDate, setBookingEndDate] = useState("");
  const [bookingPickerMonthKey, setBookingPickerMonthKey] = useState("");
  const [bookingPickerExpanded, setBookingPickerExpanded] = useState(false);
  const [bookingCallTimeOption, setBookingCallTimeOption] = useState("TBD");
  const [bookingCallTimeOther, setBookingCallTimeOther] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [bookingDayOverrides, setBookingDayOverrides] = useState<BookingDayOverrideMap>({});
  const [bookingExistingDescriptionRaw, setBookingExistingDescriptionRaw] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [isBookingSavePending, setIsBookingSavePending] = useState(false);
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const stagedLoadingCopy = useStagedLoadingCopy(isBookingSavePending || isDeletePending);
  const normalizedEditorId = resolvedEditorId?.trim().toLowerCase() ?? null;
  const isMikeEditor = normalizedEditorId === "mike";
  const isJeffCreateModeSelectable = normalizedEditorId === "jeff" || normalizedEditorId === "legacy";
  const defaultBookingMode: "la" | "overture" = isMikeEditor ? "overture" : "la";

  useEffect(() => {
    if (!activeDetailPanel && !activeBookingPanel) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isBookingSavePending || isDeletePending) return;
        setActiveDetailPanel(null);
        closeBookingPanel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetailPanel, activeBookingPanel, isBookingSavePending, isDeletePending]);

  useEffect(() => {
    const fromProp = sanitizeEditorToken(initialEditorToken);
    const fromUrl = sanitizeEditorToken(
      new URLSearchParams(window.location.search).get("editor"),
    );
    const fromSession = sanitizeEditorToken(
      window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY),
    );
    const resolved = fromProp ?? fromUrl ?? fromSession;

    if (resolved) {
      window.localStorage.setItem(EDITOR_TOKEN_SESSION_KEY, resolved);
      setEditorToken(resolved);
    } else {
      setEditorToken(null);
    }
  }, [initialEditorToken]);

  useEffect(() => {
    setResolvedEditorId(initialResolvedEditorId);
  }, [initialResolvedEditorId]);

  const closeDetailPanel = () => {
    setActiveDetailPanel(null);
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
  };

  const closeBookingPanel = () => {
    setActiveBookingPanel(null);
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate("");
    setBookingPickerMonthKey("");
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
    setBookingDayOverrides({});
    setBookingExistingDescriptionRaw("");
    setBookingError(null);
    setIsBookingSavePending(false);
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
  };

  const openBookingPanel = (date: string) => {
    const startMonthKey = DateTime.fromISO(date, { zone: "utc" }).toFormat("yyyy-LL");
    setActiveDetailPanel(null);
    setActiveBookingPanel({ mode: "create", date, bookingMode: defaultBookingMode });
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate(date);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
    setBookingDayOverrides({});
    setBookingExistingDescriptionRaw("");
    setBookingError(null);
    setConfirmDeleteEventId(null);
    setDeleteError(null);
  };

  const openEditBookingPanel = (detail: BookedLabel["details"][number]) => {
    const startDate = detail.startDate ?? detail.startUtc?.slice(0, 10) ?? "";
    const endDate = detail.endDateInclusive ?? detail.endUtc?.slice(0, 10) ?? startDate;
    if (!startDate || !detail.eventId) {
      return;
    }

    const summary = parseLaJobSummary(detail.summary);
    const parsedDescription = parseGigDescription(detail.description);
    const startMonthKey = DateTime.fromISO(startDate, { zone: "utc" }).toFormat("yyyy-LL");
    const editBookingMode = resolveBookingModeFromDetail(detail, isMikeEditor, overtureCalendarId);

    const globalCallTimeOption = parsedDescription.callTime && isCallTimeOption(parsedDescription.callTime)
      ? parsedDescription.callTime
      : parsedDescription.callTime
        ? "Other"
        : "TBD";
    const globalCallTimeOther = parsedDescription.callTime && !isCallTimeOption(parsedDescription.callTime)
      ? parsedDescription.callTime
      : "";

    const rehydratedDayOverrides: BookingDayOverrideMap = {};
    if (parsedDescription.dayDetails) {
      for (const [date, dayDetail] of Object.entries(parsedDescription.dayDetails)) {
        const savedTime = dayDetail.startTime?.trim() ?? "";
        const savedNotes = dayDetail.notes?.trim() ?? "";
        const dayCallTimeOption = savedTime && isCallTimeOption(savedTime)
          ? savedTime
          : savedTime
            ? "Other"
            : "TBD";
        const dayCallTimeOther = savedTime && !isCallTimeOption(savedTime) ? savedTime : "";
        const differsFromGlobal = dayCallTimeOption !== globalCallTimeOption
          || dayCallTimeOther !== globalCallTimeOther;
        if (differsFromGlobal || savedNotes) {
          rehydratedDayOverrides[date] = {
            callTimeOption: dayCallTimeOption,
            callTimeOther: dayCallTimeOther,
            notes: savedNotes,
          };
        }
      }
    }

    setActiveBookingPanel({
      mode: "edit",
      eventId: detail.eventId,
      date: startDate,
      bookingMode: editBookingMode,
    });
    setBookingLaNumber(editBookingMode === "overture" ? "" : (summary.jobNumber?.replace(/\D/g, "") ?? ""));
    setBookingJobName(editBookingMode === "overture" ? (parsedDescription.jobTitle?.trim() ?? "") : summary.jobName);
    setBookingEndDate(endDate);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption(globalCallTimeOption);
    setBookingCallTimeOther(globalCallTimeOther);
    setBookingNotes(parsedDescription.jobNotes ?? "");
    setBookingDayOverrides(rehydratedDayOverrides);
    setBookingExistingDescriptionRaw(detail.description ?? "");
    setBookingError(null);
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
    setActiveDetailPanel(null);
  };

  const applySameDaySelection = () => {
    if (!activeBookingPanel) return;
    const sameDay = activeBookingPanel.date;
    setBookingEndDate(sameDay);
    setBookingPickerMonthKey(DateTime.fromISO(sameDay, { zone: "utc" }).toFormat("yyyy-LL"));
    setBookingPickerExpanded(false);
    if (bookingError) setBookingError(null);
  };

  const updateBookingDayOverride = (
    date: string,
    patch: Partial<BookingDayOverride>,
  ) => {
    setBookingDayOverrides((current) => {
      const previous = current[date] ?? {
        callTimeOption: bookingCallTimeOption,
        callTimeOther: bookingCallTimeOther,
        notes: "",
      };
      return {
        ...current,
        [date]: {
          ...previous,
          ...patch,
        },
      };
    });
    if (bookingError) setBookingError(null);
  };

  async function saveBooking() {
    if (!activeBookingPanel || isBookingSavePending) return;
    if (!editorModeActive) {
      setBookingError("Editor token missing. Re-open the editor link.");
      return;
    }
    let summary: string;
    if (activeBookingPanel.bookingMode === "overture") {
      summary = "Overture";
    } else {
      try {
        summary = buildLaJobSummary(bookingLaNumber, bookingJobName);
      } catch (error) {
        setBookingError(error instanceof Error ? error.message : "Invalid LA job details.");
        return;
      }
    }
    const startDate = activeBookingPanel.date;
    const endDate = bookingEndDate.trim() || startDate;
    if (!DateTime.fromISO(endDate, { zone: "utc" }).isValid) {
      setBookingError("Select a valid End Date.");
      return;
    }
    if (endDate < startDate) {
      setBookingError("End Date cannot be before Start Date.");
      return;
    }

    setBookingError(null);
    setIsBookingSavePending(true);
    const callTime = resolveCallTimeFromInputs(bookingCallTimeOption, bookingCallTimeOther);
    if (bookingCallTimeOption === "Other" && !callTime) {
      setBookingError("Enter a custom Call Time or choose another option.");
      setIsBookingSavePending(false);
      return;
    }
    const selectedDates = enumerateIsoDatesInRange(startDate, endDate);
    const bookingHasMultiDayRange = selectedDates.length > 1;
    const dailyOverrides = bookingHasMultiDayRange
      ? selectedDates
      .map((date) => {
        const override = bookingDayOverrides[date];
        if (!override) return null;
        const overrideCallTime = resolveCallTimeFromInputs(override.callTimeOption, override.callTimeOther);
        if (override.callTimeOption === "Other" && !overrideCallTime) {
          return { date, invalid: true as const };
        }
        return {
          date,
          startTime: overrideCallTime,
          notes: override.notes,
        };
      })
      .filter((row): row is { date: string; startTime: string; notes: string } | { date: string; invalid: true } => row != null)
      : [];
    const invalidDailyOverride = bookingHasMultiDayRange
      ? dailyOverrides.find((detail) => "invalid" in detail)
      : null;
    if (bookingHasMultiDayRange && invalidDailyOverride) {
      setBookingError(`Enter a custom start time for ${formatCompactDate(invalidDailyOverride.date)} or choose another option.`);
      setIsBookingSavePending(false);
      return;
    }
    const dayDetails = bookingHasMultiDayRange
      ? buildGigDayDetailsForRange({
          startDate,
          endDateInclusive: endDate,
          defaultStartTime: callTime,
          defaultNotes: undefined,
          overrides: dailyOverrides,
        })
      : undefined;
    const overtureJobTitle = activeBookingPanel.bookingMode === "overture" && bookingJobName.trim()
      ? bookingJobName.trim()
      : undefined;
    const description = activeBookingPanel.mode === "edit"
      ? mergeGigDescriptionWithDailyDetailsBlock(bookingExistingDescriptionRaw, {
          callTime,
          jobNotes: bookingNotes,
          dayDetails,
          jobTitle: overtureJobTitle,
        })
      : buildGigDescription(callTime, bookingNotes, dayDetails, overtureJobTitle);

    try {
      const endpoint = activeBookingPanel.mode === "edit"
        ? activeBookingPanel.eventId
          ? `/api/gigs/${encodeURIComponent(activeBookingPanel.eventId)}`
          : null
        : "/api/gigs/create";
      if (!endpoint) {
        setBookingError("Missing event id for edit.");
        setIsBookingSavePending(false);
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (editorToken) {
        headers.Authorization = `Bearer ${editorToken}`;
      }
      const response = await fetch(endpoint, {
        method: activeBookingPanel.mode === "edit" ? "PATCH" : "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({
          summary,
          ...(description ? { description } : {}),
          ...(activeBookingPanel.mode === "create" ? { bookingMode: activeBookingPanel.bookingMode } : {}),
          startDate,
          endDate,
        }),
      });

      if (response.ok) {
        closeBookingPanel();
        onMutationSuccess?.();
        router.refresh();
        return;
      }

      if (response.status === 401) {
        window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
        setResolvedEditorId(null);
        setBookingError("Editor session expired. Re-open the editor link.");
        return;
      }

      let message = "Could not save booking.";
      try {
        const payload = await response.json() as { message?: string };
        if (payload.message?.trim()) {
          message = payload.message.trim();
        }
      } catch {
        // ignore parse issues and keep generic message
      }
      setBookingError(message);
    } catch {
      setBookingError("Network error while saving booking.");
    } finally {
      setIsBookingSavePending(false);
    }
  }

  async function deleteActiveGig(eventId: string) {
    if (!editorModeActive || isDeletePending) return;

    setDeleteError(null);
    setIsDeletePending(true);
    try {
      const headers: Record<string, string> = {};
      if (editorToken) {
        headers.Authorization = `Bearer ${editorToken}`;
      }
      const response = await fetch(`/api/gigs/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        headers,
        credentials: "same-origin",
      });

      if (response.ok) {
        setConfirmDeleteEventId(null);
        setActiveDetailPanel(null);
        onMutationSuccess?.();
        router.refresh();
        return;
      }

      if (response.status === 401) {
        window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
        setResolvedEditorId(null);
        setDeleteError("Editor session expired. Re-open the editor link.");
        return;
      }

      let message = "Could not delete job.";
      try {
        const payload = await response.json() as { message?: string; error?: string };
        if (payload.message?.trim()) {
          message = payload.message.trim();
        } else if (payload.error?.trim()) {
          message = `Could not delete job (${response.status} ${payload.error.trim()}).`;
        }
      } catch {
        // ignore parse issues and keep generic message
      }
      setDeleteError(message);
    } catch {
      setDeleteError("Network error while deleting job.");
    } finally {
      setIsDeletePending(false);
    }
  }

  const hideWeekends = isMikeEditor && !showWeekends;
  const visibleWeeks = filterWeekRowsByWeekendVisibility(weeks, hideWeekends);
  const weekendMarkerDayNumber = weekendTodayLabel?.match(/(\d{1,2})$/)?.[1] ?? null;
  const weekendMarkerLabelPrefix =
    weekendTodayLabel && weekendMarkerDayNumber
      ? weekendTodayLabel.slice(0, -weekendMarkerDayNumber.length)
      : weekendTodayLabel;
  const weekendMarker = !hideWeekends && weekendTodayLabel ? (
    <div className="board-weekend-marker" aria-label={`Today: ${weekendTodayLabel}`}>
      {weekendMarkerDayNumber && weekendMarkerLabelPrefix ? (
        <span className="board-day-label-today">
          <span>{weekendMarkerLabelPrefix}</span>
          <span className="board-day-today" aria-label="Today">
            {weekendMarkerDayNumber}
          </span>
        </span>
      ) : (
        weekendTodayLabel
      )}
    </div>
  ) : null;
  const hasRows = visibleWeeks.some((wk) => wk.days.length > 0);

  const openDetailPanelForRow = (rowKey: string, bookedLabel: BookedLabel, date: string): void => {
    onDateFocus?.(date);
    closeBookingPanel();
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    if (activeDetailPanel?.rowKey === rowKey) {
      setActiveDetailPanel(null);
      return;
    }

    const header = bookedLabel.jobNumber
      ?? bookedLabel.details[0]?.summary
      ?? bookedLabel.label
      ?? "Busy";

    setActiveDetailPanel({
      rowKey,
      selectedDate: date,
      header,
      ...(bookedLabel.jobNumber
        ? { headerJobNumber: bookedLabel.jobNumber }
        : {}),
      details: bookedLabel.details,
    });
  };

  const buildGroupedDayInlineMeta = (bookedLabel: BookedLabel): string | null => {
    const timeLabels = [...new Set(
      bookedLabel.details
        .map((detail) => detail.timeRangeLabel?.trim())
        .filter((label): label is string => !!label),
    )];
    if (timeLabels.length === 0) return null;
    const [first, ...rest] = timeLabels;
    if (!first) return null;
    return rest.length > 0 ? `${first} +${rest.length}` : first;
  };

  const weekRows = visibleWeeks.map((wk) => ({
    wk,
    rows: buildWeekRenderRows({
      week: wk,
      timezone: "utc",
      groupSameJobNumbers: GROUP_SAME_JOB_NUMBERS_ENABLED,
    }),
  }));
  const editorModeActive = !!(editorToken || resolvedEditorId);
  const isOvertureBookingMode = activeBookingPanel?.bookingMode === "overture";
  const showBookingModeSelector = !!(
    activeBookingPanel
    && activeBookingPanel.mode === "create"
    && isJeffCreateModeSelectable
  );
  const bookingDateLabel = activeBookingPanel
    ? formatShortDate(activeBookingPanel.date)
    : null;
  const bookingStartDate = activeBookingPanel?.date ?? "";
  const bookingStartMonth = bookingStartDate
    ? DateTime.fromISO(bookingStartDate, { zone: "utc" }).startOf("month")
    : null;
  const bookingViewMonth = bookingPickerMonthKey
    ? DateTime.fromFormat(bookingPickerMonthKey, "yyyy-LL", { zone: "utc" }).startOf("month")
    : bookingStartMonth;
  const bookingCalendar = bookingStartDate
    && bookingViewMonth?.isValid
    ? buildBookingCalendarDays(bookingStartDate, bookingViewMonth.toFormat("yyyy-LL"))
    : null;
  const parsedBookingEndDate = bookingEndDate.trim() || "";
  const bookingStartLabel = bookingStartDate ? formatShortDate(bookingStartDate) : "";
  const bookingRangeLabel = bookingStartDate
    ? (() => {
        if (!parsedBookingEndDate) {
          return "Select end date";
        }
        if (parsedBookingEndDate === bookingStartDate) {
          return `${bookingStartLabel} only`;
        }
        if (parsedBookingEndDate > bookingStartDate) {
          return `${bookingStartLabel} – ${formatShortDate(parsedBookingEndDate)}`;
        }
        return "Select end date";
      })()
    : "Select end date";
  const bookingSelectedDates = bookingStartDate && parsedBookingEndDate
    ? enumerateIsoDatesInRange(bookingStartDate, parsedBookingEndDate >= bookingStartDate ? parsedBookingEndDate : bookingStartDate)
    : [];
  const bookingHasMultiDayRange = bookingSelectedDates.length > 1;
  const overallJobNotesLabel = "Job Notes";
  const resolveCallTimeFromInputs = (option: string, other: string): string => (
    option === "Other" ? other.trim() : option.trim()
  );
  const defaultCallTimeValue = resolveCallTimeFromInputs(bookingCallTimeOption, bookingCallTimeOther);
  const canGoToPreviousBookingMonth = bookingStartMonth && bookingViewMonth
    ? bookingViewMonth > bookingStartMonth
    : false;
  const activeEditableDetail = activeDetailPanel
    ? findEditableDetail(
        activeDetailPanel.details,
        normalizedEditorId,
        editorCalendarId,
        overtureCalendarId,
      )
    : null;
  const activeDetailIsOverture = !!(
    activeDetailPanel
    && activeDetailPanel.details.some((detail) => isOvertureDetail(detail, overtureCalendarId))
  );
  const activeDetailIsLa = !!(
    activeDetailPanel
    && activeDetailPanel.details.some((detail) => isLaDetail(detail, editorCalendarId, overtureCalendarId))
  );
  const activeSelectedDate = activeDetailPanel?.selectedDate ?? null;
  const activePrimaryDetail = activeDetailPanel && activeSelectedDate
    ? activeDetailPanel.details.find((detail) => detailIncludesDate(detail, activeSelectedDate))
      ?? activeDetailPanel.details[0]
      ?? null
    : null;
  const activePrimaryDetailCanViewNotes = !!(
    activePrimaryDetail
    && canViewDetailNotes(
      activePrimaryDetail,
      normalizedEditorId,
      editorCalendarId,
      overtureCalendarId,
    )
  );
  const activeSelectedDayMeta = activePrimaryDetail && activeSelectedDate
    ? resolveSelectedDayPopupMeta(activePrimaryDetail, activeSelectedDate)
    : null;
  const activeDetailRangeBounds = activeDetailPanel
    ? activeDetailPanel.details
      .map((detail) => {
        const startDate = detail.startDate ?? detail.startUtc?.slice(0, 10);
        const endDateInclusive = detail.endDateInclusive ?? detail.endUtc?.slice(0, 10) ?? startDate;
        if (!startDate || !endDateInclusive || endDateInclusive < startDate) return null;
        return { startDate, endDateInclusive };
      })
      .filter((value): value is { startDate: string; endDateInclusive: string } => value != null)
      .reduce<{ startDate: string; endDateInclusive: string } | null>((acc, current) => {
        if (!acc) return current;
        return {
          startDate: current.startDate < acc.startDate ? current.startDate : acc.startDate,
          endDateInclusive: current.endDateInclusive > acc.endDateInclusive
            ? current.endDateInclusive
            : acc.endDateInclusive,
        };
      }, null)
    : null;
  const activeDetailIsMultiDay = !!(
    activeDetailRangeBounds
    && activeDetailRangeBounds.startDate !== activeDetailRangeBounds.endDateInclusive
  );
  const activeDetailRangeLabel = activeDetailRangeBounds
    ? formatPopupDateRange(activeDetailRangeBounds.startDate, activeDetailRangeBounds.endDateInclusive)
    : activePrimaryDetail?.dateRangeLabel ?? null;
  const activeDetailDayRows = (() => {
    if (!activeDetailPanel || !activeDetailRangeBounds) return [] as Array<{ date: string; startTime: string | null; dayNotes: string | null }>;
    return enumerateIsoDatesInRange(
      activeDetailRangeBounds.startDate,
      activeDetailRangeBounds.endDateInclusive,
    ).map((date) => {
      let startTime: string | null = null;
      let dayNotes: string | null = null;
      for (const detail of activeDetailPanel.details) {
        if (!detailIncludesDate(detail, date)) continue;
        if (!canViewDetailNotes(detail, normalizedEditorId, editorCalendarId, overtureCalendarId)) continue;
        const parsed = parseGigDescription(detail.description);
        const resolved = resolveParsedGigDetailForDate(parsed, date);
        if (!startTime && resolved.startTime?.trim()) startTime = resolved.startTime.trim();
        if (!dayNotes && parsed.dayDetails?.[date]?.notes?.trim()) dayNotes = parsed.dayDetails[date]?.notes?.trim() ?? null;
      }
      return { date, startTime, dayNotes };
    });
  })();
  const activeDetailOverallNotes = (() => {
    if (!activeDetailPanel) return null;
    for (const detail of activeDetailPanel.details) {
      if (!canViewDetailNotes(detail, normalizedEditorId, editorCalendarId, overtureCalendarId)) continue;
      const notes = parseGigDescription(detail.description).jobNotes?.trim();
      if (notes) return notes;
    }
    return null;
  })();
  const activeDetailJobTitle = (() => {
    if (!activePrimaryDetail || !activeDetailPanel) return null;
    if (activeDetailIsOverture) {
      if (!activePrimaryDetailCanViewNotes) return null;
      return parseGigDescription(activePrimaryDetail.description).jobTitle?.trim() || null;
    }
    const t = stripJobPrefix(activePrimaryDetail.summary, activeDetailPanel.headerJobNumber);
    return t && t.toLowerCase() !== activeDetailPanel.header.toLowerCase() ? t : null;
  })();
  const canManageActiveDetail = editorModeActive
    && !!activeEditableDetail;
  const showDeleteConfirm = !!confirmDeleteEventId
    && !!activeEditableDetail
    && confirmDeleteEventId === activeEditableDetail.eventId;
  const detailModalIsLocked = isDeletePending;
  const bookingModalIsLocked = isBookingSavePending;
  const renderLoadingOverlay = (title: "Saving job…" | "Deleting job…") => (
    <div className="board-day-modal-loading-overlay" role="status" aria-live="polite">
      <div className="board-day-modal-loading-indicator">
        <div className="board-day-modal-loading-spinner" aria-hidden="true">
          <div className="board-day-modal-loading-spinner-track" />
          <div className="board-day-modal-loading-spinner-arc" />
        </div>
        <p className="board-day-modal-loading-title">{title}</p>
        <p className="board-day-modal-loading-copy">{stagedLoadingCopy}</p>
      </div>
    </div>
  );
  const swipeDisabled = !!activeDetailPanel || !!activeBookingPanel || isDeletePending || isBookingSavePending;

  const onTouchStart: TouchEventHandler<HTMLDivElement> = (event) => {
    if (swipeDisabled) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, select, textarea, [role='button']")) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    swipeRef.current = {
      tracking: true,
      startX: touch.clientX,
      startY: touch.clientY,
      moved: false,
    };
  };

  const onTouchMove: TouchEventHandler<HTMLDivElement> = (event) => {
    const state = swipeRef.current;
    if (!state.tracking || state.moved || swipeDisabled) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - state.startX;
    const dy = touch.clientY - state.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDy > absDx && absDy > 16) {
      state.tracking = false;
      return;
    }

    if (absDx < 64 || absDx <= absDy) return;

    state.moved = true;
    state.tracking = false;
    if (dx < 0 && canGoNext && nextHref) {
      if (onNavigate) {
        onNavigate(nextHref);
      } else {
        router.push(nextHref);
      }
      return;
    }
    if (dx > 0 && canGoPrev && prevHref) {
      if (onNavigate) {
        onNavigate(prevHref);
      } else {
        router.push(prevHref);
      }
    }
  };

  const onTouchEnd: TouchEventHandler<HTMLDivElement> = () => {
    swipeRef.current.tracking = false;
  };

  const onTouchCancel: TouchEventHandler<HTMLDivElement> = () => {
    swipeRef.current.tracking = false;
  };

  if (!hasRows) {
    return (
      <div
        className="board"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {weekendMarker}
        <div className="board-empty" role="status">
          No availability rows for this range.
        </div>
      </div>
    );
  }

  return (
    <div
      className="board"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {weekendMarker}
      {weekRows.map((week) => (
        <section
          key={week.wk.weekOf}
          className="board-week"
          aria-label={week.wk.label}
        >
          <h2 className="board-week-label period-label-animate">{week.wk.label}</h2>
          <ul className="board-days">
            {week.rows.map((row, rowIndex) => {
              if (row.kind === "job-group") {
                const groupKey = `${week.wk.weekOf}-${row.jobNumber}-${row.days[0]?.day.date ?? rowIndex}`;
                return (
                  <li key={groupKey} className="board-day-group">
                    <div className="board-day-group-header">
                      <span className="board-day-group-job">{row.jobNumber}</span>
                      <span className="board-day-group-range">{row.dateRangeLabel}</span>
                    </div>
                    <ul className="board-day-group-days">
                      {row.days.map((groupDay, groupDayIndex) => {
                        const d = groupDay.day;
                        const bookedLabel = groupDay.bookedLabel;
                        const rowKey = `${week.wk.weekOf}-${d.date}`;
                        const todayDayNumber = String(Number(d.date.slice(8, 10)));
                        const todayLabelPrefix =
                          d.isToday && d.label.endsWith(todayDayNumber)
                            ? d.label.slice(0, -todayDayNumber.length)
                            : null;
                        const inlineMeta = buildGroupedDayInlineMeta(bookedLabel);
                        return (
                          <li
                            key={`${d.date}-${groupDayIndex}`}
                            className={`board-day board-day--group-child booked${d.isToday ? " today" : ""}${d.isToday && todayPulseActive ? " today-pulse" : ""}`}
                            tabIndex={0}
                            onClick={() => {
                              openDetailPanelForRow(rowKey, bookedLabel, d.date);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openDetailPanelForRow(rowKey, bookedLabel, d.date);
                              }
                            }}
                          >
                            <span className="board-day-label">
                              {todayLabelPrefix ? (
                                <span className="board-day-label-today">
                                  <span>{todayLabelPrefix}</span>
                                  <span className="board-day-today" aria-label="Today">
                                    {todayDayNumber}
                                  </span>
                                </span>
                              ) : (
                                d.label
                              )}
                            </span>
                            <span className="board-day-right">
                              {inlineMeta ? (
                                <span className="board-day-group-meta">{inlineMeta}</span>
                              ) : (
                                <span className="board-day-booked-continuation" aria-hidden="true" />
                              )}
                            </span>
                            <span className="board-day-connector board-day-connector--none" aria-hidden="true" />
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              }

              const d = row.day;
              const canBookRow = editorModeActive && d.status === "available";
              const rowKey = `${week.wk.weekOf}-${d.date}`;
              const todayDayNumber = String(Number(d.date.slice(8, 10)));
              const todayLabelPrefix =
                d.isToday && d.label.endsWith(todayDayNumber)
                  ? d.label.slice(0, -todayDayNumber.length)
                  : null;
              const connectorPart = row.connectorPart;
              const bookedLabel = row.bookedLabel;
              const bookedBadgeDisplay = bookedLabel
                ? buildWeekBookedBadgeDisplay({
                  bookedLabel,
                  connectorPart,
                })
                : null;
              return (
                <li
                  key={d.date}
                  className={`board-day ${d.status}${canBookRow ? " board-day--bookable" : ""}${row.bookedLabel?.isPrivateUnavailable ? " booked-private" : ""}${d.isToday ? " today" : ""}${d.isToday && todayPulseActive ? " today-pulse" : ""}`}
                  tabIndex={(canBookRow || (!!bookedLabel && !bookedLabel.isPrivateUnavailable)) ? 0 : undefined}
                  onClick={() => {
                    onDateFocus?.(d.date);
                    if (canBookRow) {
                      closeDetailPanel();
                      openBookingPanel(d.date);
                      return;
                    }
                    if (bookedLabel && !bookedLabel.isPrivateUnavailable) {
                      openDetailPanelForRow(rowKey, bookedLabel, d.date);
                    }
                  }}
                  onKeyDown={(canBookRow || (!!bookedLabel && !bookedLabel.isPrivateUnavailable))
                    ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onDateFocus?.(d.date);
                        if (canBookRow) {
                          closeDetailPanel();
                          openBookingPanel(d.date);
                          return;
                        }
                        if (bookedLabel && !bookedLabel.isPrivateUnavailable) {
                          openDetailPanelForRow(rowKey, bookedLabel, d.date);
                        }
                      }
                    }
                    : undefined}
                >
                  <span className="board-day-label">
                    {todayLabelPrefix ? (
                      <span className="board-day-label-today">
                        <span>{todayLabelPrefix}</span>
                        <span className="board-day-today" aria-label="Today">
                          {todayDayNumber}
                        </span>
                      </span>
                    ) : (
                      d.label
                    )}
                  </span>
                  <span className="board-day-right">
                    {d.status === "available" ? (
                      <span className="board-day-badge available">Available</span>
                    ) : bookedLabel?.isPrivateUnavailable ? (
                      <span className="board-day-unavailable-text">Unavailable</span>
                    ) : bookedLabel ? (
                      bookedBadgeDisplay?.isSubtle ? (
                        <span className="board-day-booked-continuation" aria-hidden="true" />
                      ) : bookedBadgeDisplay?.primary ? (
                        <span className="board-day-badge booked" title={bookedLabel.title}>
                          {bookedBadgeDisplay.primary}
                        </span>
                      ) : null
                    ) : (
                      <span className="board-day-badge booked">Busy</span>
                    )}
                  </span>
                  <span
                    className={`board-day-connector board-day-connector--${connectorPart}`}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {activeDetailPanel ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (detailModalIsLocked) return;
            closeDetailPanel();
          }}
        >
          <section
            id="week-job-detail-modal"
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="week-job-detail-title"
            aria-busy={detailModalIsLocked || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {detailModalIsLocked ? renderLoadingOverlay("Deleting job…") : null}
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close details"
              onClick={closeDetailPanel}
              disabled={detailModalIsLocked}
            >
              ×
            </button>

            <h3 id="week-job-detail-title" className="board-day-modal-title">
              {activeDetailIsOverture ? (
                <img
                  src="/brand/overture-logo.png"
                  alt="Overture"
                  width={166}
                  height={43}
                  fetchPriority="high"
                  decoding="async"
                  className="board-day-modal-overture-logo board-day-modal-overture-logo--title"
                />
              ) : activeDetailIsLa ? (
                <span className="board-day-modal-title-with-la-brand">
                  <img
                    src="/brand/la-logo.png"
                    alt="LA"
                    width={136}
                    height={40}
                    fetchPriority="high"
                    decoding="async"
                    className="board-day-modal-la-logo"
                  />
                  <span className="board-day-modal-title-text">{activeDetailPanel.header}</span>
                </span>
              ) : (
                activeDetailPanel.header
              )}
            </h3>

            {activePrimaryDetail ? (
              <div className="board-day-modal-events">
                {activeDetailJobTitle ? (
                  <p className="board-day-modal-event-title">{activeDetailJobTitle}</p>
                ) : null}
                {activeDetailRangeLabel ? (
                  <p className="board-day-modal-event-date">{activeDetailRangeLabel}</p>
                ) : activeSelectedDate ? (
                  <p className="board-day-modal-event-date">{formatCompactDate(activeSelectedDate)}</p>
                ) : null}
                {!activeDetailIsMultiDay && activePrimaryDetailCanViewNotes && activeSelectedDayMeta?.selectedStartTime ? (
                  <p className="board-day-modal-event-meta">
                    {activeSelectedDayMeta.selectedStartTime}
                  </p>
                ) : !activeDetailIsMultiDay && activePrimaryDetail.timeRangeLabel ? (
                  <p className="board-day-modal-event-meta">
                    {activePrimaryDetail.timeRangeLabel}
                  </p>
                ) : null}
                {!activeDetailIsMultiDay && !activeDetailRangeLabel && activePrimaryDetail.dateRangeLabel ? (
                  <p className="board-day-modal-event-meta">
                    {activePrimaryDetail.dateRangeLabel}
                  </p>
                ) : null}
                {!activeDetailIsMultiDay && activePrimaryDetailCanViewNotes && activeSelectedDayMeta?.selectedDayNotes ? (
                  <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                    {activeSelectedDayMeta.selectedDayNotes}
                  </p>
                ) : null}
                {activeDetailIsMultiDay && activeDetailDayRows.length > 0 ? (
                  <ul className="board-day-modal-day-breakdown">
                    {activeDetailDayRows.map((row) => (
                      <li key={row.date}>
                        <p className="board-day-modal-day-label">
                          <span className="board-day-modal-day-date">{formatShortDate(row.date)}</span>
                          <span className="board-day-modal-day-sep"> — </span>
                          <span className="board-day-modal-day-name">{formatDayAbbrev(row.date)}</span>
                        </p>
                        {row.startTime ? (
                          <p className="board-day-modal-event-meta">{row.startTime}</p>
                        ) : null}
                        {row.dayNotes ? (
                          <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                            {row.dayNotes}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {activePrimaryDetailCanViewNotes && activeDetailOverallNotes ? (
                  <>
                    <p className="board-day-modal-event-label">Job Notes</p>
                    <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                      {activeDetailOverallNotes}
                    </p>
                  </>
                ) : null}
                {activeDetailPanel.details.length > 1 ? (
                  <p className="board-day-modal-event-meta">
                    <span className="board-day-modal-event-label">Events</span>{" "}
                    {activeDetailPanel.details.length}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="board-day-modal-empty">No event details available.</p>
            )}

            {canManageActiveDetail ? (
              <div className="board-day-modal-actions">
                {showDeleteConfirm ? (
                  <div className="board-day-modal-confirm-delete">
                    <p className="board-day-modal-confirm-title">Delete this job?</p>
                    <p className="board-day-modal-confirm-copy">
                      This removes it from the calendar.
                    </p>
                    {deleteError ? (
                      <p className="month-booking-error" role="alert">{deleteError}</p>
                    ) : null}
                    <div className="board-day-modal-confirm-buttons">
                      <button
                        type="button"
                        className="month-booking-button month-booking-button--secondary"
                        onClick={() => setConfirmDeleteEventId(null)}
                        disabled={detailModalIsLocked}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="month-booking-button month-booking-button--danger"
                        onClick={() => {
                          if (!activeEditableDetail.eventId) return;
                          void deleteActiveGig(activeEditableDetail.eventId);
                        }}
                        disabled={detailModalIsLocked}
                      >
                        {detailModalIsLocked ? "Deleting..." : "Confirm Delete"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="board-day-modal-action-buttons">
                    <button
                      type="button"
                      className="month-booking-button month-booking-button--secondary"
                      onClick={() => openEditBookingPanel(activeEditableDetail)}
                      disabled={detailModalIsLocked}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="month-booking-button month-booking-button--secondary"
                      onClick={() => {
                        if (!activeEditableDetail.eventId) return;
                        setConfirmDeleteEventId(activeEditableDetail.eventId);
                        setDeleteError(null);
                      }}
                      disabled={detailModalIsLocked}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {activeBookingPanel ? (
        <div
          className="board-day-modal-backdrop board-day-modal-backdrop--booking"
          role="presentation"
          onClick={() => {
            if (bookingModalIsLocked) return;
            closeBookingPanel();
          }}
        >
          <section
            id="week-booking-modal"
            className="board-day-modal board-day-modal--booking"
            role="dialog"
            aria-modal="true"
            aria-labelledby="week-booking-title"
            aria-busy={bookingModalIsLocked || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {bookingModalIsLocked ? renderLoadingOverlay("Saving job…") : null}
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close booking editor"
              onClick={closeBookingPanel}
              disabled={bookingModalIsLocked}
            >
              ×
            </button>

            <h3 id="week-booking-title" className="board-day-modal-title">
              Book Job
            </h3>
            <p className="board-day-modal-event-date">{bookingDateLabel}</p>

            <div className="month-booking-form">
              {showBookingModeSelector ? (
                <div className="month-booking-mode">
                  <p className="month-booking-label">Booking Type</p>
                  <div className="month-booking-mode-options" role="group" aria-label="Booking type">
                    <button
                      type="button"
                      className={`month-booking-mode-button${activeBookingPanel?.bookingMode === "la" ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveBookingPanel((current) => {
                          if (!current || current.mode !== "create") return current;
                          return { ...current, bookingMode: "la" };
                        });
                        if (bookingError) setBookingError(null);
                      }}
                      disabled={bookingModalIsLocked}
                    >
                      LA Job
                    </button>
                    <button
                      type="button"
                      className={`month-booking-mode-button${activeBookingPanel?.bookingMode === "overture" ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveBookingPanel((current) => {
                          if (!current || current.mode !== "create") return current;
                          return { ...current, bookingMode: "overture" };
                        });
                        if (bookingError) setBookingError(null);
                      }}
                      disabled={bookingModalIsLocked}
                    >
                      Overture
                    </button>
                  </div>
                </div>
              ) : null}
              {isOvertureBookingMode ? (
                <>
                  <p className="board-day-modal-event-meta board-day-modal-overture-brand board-day-modal-overture-brand--booking">
                    <img
                      src="/brand/overture-logo.png"
                      alt="Overture"
                      width={150}
                      height={44}
                      fetchPriority="high"
                      decoding="async"
                      className="board-day-modal-overture-logo board-day-modal-overture-logo--booking"
                    />
                  </p>
                  <label className="month-booking-label" htmlFor="week-booking-overture-title">
                    Job Title
                  </label>
                  <input
                    id="week-booking-overture-title"
                    name="overture-job-title"
                    className="month-booking-input"
                    autoComplete="off"
                    autoCapitalize="words"
                    value={bookingJobName}
                    onChange={(event) => {
                      setBookingJobName(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    placeholder="Event name"
                    maxLength={200}
                    disabled={bookingModalIsLocked}
                  />
                </>
              ) : (
                <>
                  <label
                    className="month-booking-label board-day-modal-la-brand-label"
                    htmlFor="week-booking-la-number"
                  >
                    <img
                      src="/brand/la-logo.png"
                      alt="LA"
                      width={132}
                      height={40}
                      fetchPriority="high"
                      decoding="async"
                      className="board-day-modal-la-logo board-day-modal-la-logo--booking"
                    />
                  </label>
                  <div className="month-booking-la-field">
                    <span className="month-booking-la-prefix" aria-hidden="true">LA#</span>
                    <input
                      id="week-booking-la-number"
                      name="job-number"
                      className="month-booking-input month-booking-input--la"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={bookingLaNumber}
                      onChange={(event) => {
                        setBookingLaNumber(event.target.value.replace(/\D/g, ""));
                        if (bookingError) setBookingError(null);
                      }}
                      placeholder="71411"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={12}
                      autoFocus
                      disabled={bookingModalIsLocked}
                    />
                  </div>

                  <label className="month-booking-label" htmlFor="week-booking-job-title">
                    Job Title
                  </label>
                  <input
                    id="week-booking-job-title"
                    name="job-title"
                    className="month-booking-input"
                    autoComplete="off"
                    autoCapitalize="words"
                    value={bookingJobName}
                    onChange={(event) => {
                      setBookingJobName(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    placeholder="Wilmington Flower Market"
                    maxLength={200}
                    disabled={bookingModalIsLocked}
                  />
                </>
              )}

              <p className="month-booking-label">Date Range</p>
              <div className="month-booking-end-date-control">
                <button
                  type="button"
                  className={`month-booking-range-toggle${bookingPickerExpanded ? " is-open" : ""}`}
                  onClick={() => setBookingPickerExpanded((prev) => !prev)}
                  aria-expanded={bookingPickerExpanded}
                  aria-controls="week-booking-calendar-panel"
                  disabled={bookingModalIsLocked}
                >
                  <span>{bookingRangeLabel}</span>
                  <span className="month-booking-range-toggle-caret" aria-hidden="true">▾</span>
                </button>
                {bookingPickerExpanded && bookingCalendar && bookingViewMonth ? (
                  <div
                    id="week-booking-calendar-panel"
                    className="month-booking-calendar"
                    role="group"
                    aria-label="End date calendar"
                  >
                    <div className="month-booking-calendar-head">
                      <button
                        type="button"
                        className="month-booking-calendar-nav"
                        onClick={() => {
                          if (!bookingViewMonth) return;
                          setBookingPickerMonthKey(bookingViewMonth.minus({ months: 1 }).toFormat("yyyy-LL"));
                          if (bookingError) setBookingError(null);
                        }}
                        disabled={bookingModalIsLocked || !canGoToPreviousBookingMonth}
                        aria-label="Previous month"
                      >
                        ‹
                      </button>
                      <div className="month-booking-calendar-header">{bookingCalendar.monthLabel}</div>
                      <button
                        type="button"
                        className="month-booking-calendar-nav"
                        onClick={() => {
                          if (!bookingViewMonth) return;
                          setBookingPickerMonthKey(bookingViewMonth.plus({ months: 1 }).toFormat("yyyy-LL"));
                          if (bookingError) setBookingError(null);
                        }}
                        disabled={bookingModalIsLocked}
                        aria-label="Next month"
                      >
                        ›
                      </button>
                    </div>
                    <div className="month-booking-calendar-weekdays" aria-hidden="true">
                      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                    </div>
                    <div className="month-booking-calendar-grid">
                      {bookingCalendar.days.map((day) => {
                        const isSelected = bookingEndDate === day.isoDate;
                        const isStart = day.isoDate === bookingStartDate;
                        const isEnd = day.isoDate === bookingEndDate;
                        const isInRange = !!bookingEndDate
                          && day.isoDate > bookingStartDate
                          && day.isoDate < bookingEndDate;
                        const isDisabled = day.isBeforeStart;
                        return (
                          <button
                            key={day.isoDate}
                            type="button"
                            className={[
                              "month-booking-calendar-day",
                              day.isCurrentMonth ? "is-current-month" : "is-outside-month",
                              isSelected ? "is-selected" : "",
                              isStart ? "is-start" : "",
                              isEnd ? "is-end" : "",
                              isInRange ? "is-in-range" : "",
                            ].filter(Boolean).join(" ")}
                            disabled={bookingModalIsLocked || isDisabled}
                            onClick={() => {
                              setBookingEndDate(day.isoDate);
                              setBookingPickerExpanded(false);
                              if (bookingError) setBookingError(null);
                            }}
                            aria-label={`End date ${formatCompactDate(day.isoDate)}`}
                          >
                            {day.dayNumber}
                          </button>
                        );
                      })}
                    </div>
                    <div className="month-booking-calendar-actions">
                      <button
                        type="button"
                        className={`month-booking-same-day-button${bookingEndDate === bookingStartDate ? " is-active" : ""}`}
                        onClick={applySameDaySelection}
                        disabled={bookingModalIsLocked}
                      >
                        Same day
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {!bookingHasMultiDayRange ? (
                <>
                  <label className="month-booking-label" htmlFor="week-booking-call-time">
                    Call Time
                  </label>
                  <select
                    id="week-booking-call-time"
                    name="job-call-time"
                    className="month-booking-input"
                    autoComplete="off"
                    value={bookingCallTimeOption}
                    onChange={(event) => {
                      setBookingCallTimeOption(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    disabled={bookingModalIsLocked}
                  >
                    {CALL_TIME_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                    <option value="Other">Other</option>
                  </select>
                  {bookingCallTimeOption === "Other" ? (
                    <input
                      id="week-booking-call-time-other"
                      name="job-call-time-other"
                      className="month-booking-input month-booking-input--small"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={bookingCallTimeOther}
                      onChange={(event) => {
                        setBookingCallTimeOther(event.target.value);
                        if (bookingError) setBookingError(null);
                      }}
                      placeholder="Custom call time"
                      maxLength={120}
                      disabled={bookingModalIsLocked}
                    />
                  ) : null}
                </>
              ) : null}

              {bookingHasMultiDayRange ? (
                <div className="month-booking-daily-details">
                  <p className="month-booking-label">
                    Call Times
                  </p>
                  <div className="month-booking-daily-list">
                    {bookingSelectedDates.map((date) => {
                      const override = bookingDayOverrides[date];
                      const dayCallTimeOption = override?.callTimeOption ?? bookingCallTimeOption;
                      const dayCallTimeOther = override?.callTimeOther ?? bookingCallTimeOther;
                      const dayNotes = override?.notes ?? "";
                      return (
                        <div key={date} className="month-booking-daily-row">
                          <div className="month-booking-daily-row-header">
                            <span className="board-day-modal-day-date">{formatShortDate(date)}</span>
                            <span className="board-day-modal-day-sep"> — </span>
                            <span className="board-day-modal-day-name">{formatDayAbbrev(date)}</span>
                          </div>
                          <select
                            className="month-booking-input month-booking-input--small"
                            value={dayCallTimeOption}
                            onChange={(event) => {
                              updateBookingDayOverride(date, { callTimeOption: event.target.value });
                            }}
                            disabled={bookingModalIsLocked}
                          >
                            {CALL_TIME_OPTIONS.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                            <option value="Other">Other</option>
                          </select>
                          {dayCallTimeOption === "Other" ? (
                            <input
                              className="month-booking-input month-booking-input--small"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="off"
                              spellCheck={false}
                              value={dayCallTimeOther}
                              onChange={(event) => {
                                updateBookingDayOverride(date, { callTimeOther: event.target.value });
                              }}
                              placeholder="Custom start time"
                              maxLength={120}
                              disabled={bookingModalIsLocked}
                            />
                          ) : null}
                          <input
                            className="month-booking-input month-booking-input--small"
                            autoComplete="off"
                            autoCapitalize="sentences"
                            value={dayNotes}
                            onChange={(event) => {
                              updateBookingDayOverride(date, { notes: event.target.value });
                            }}
                            placeholder="Notes"
                            maxLength={4000}
                            disabled={bookingModalIsLocked}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <label className="month-booking-label" htmlFor="week-booking-notes">
                {overallJobNotesLabel}
              </label>
              <textarea
                id="week-booking-notes"
                name="job-notes"
                className="month-booking-textarea"
                autoComplete="off"
                autoCapitalize="sentences"
                value={bookingNotes}
                onChange={(event) => {
                  setBookingNotes(event.target.value);
                  if (bookingError) setBookingError(null);
                }}
                placeholder="Venue notes, contact, etc."
                maxLength={4000}
                rows={4}
                disabled={bookingModalIsLocked}
              />

            </div>

            {bookingError ? (
              <p className="month-booking-error" role="alert">{bookingError}</p>
            ) : null}

            <div className="month-booking-actions">
              <button
                type="button"
                className="month-booking-button month-booking-button--secondary"
                onClick={closeBookingPanel}
                disabled={bookingModalIsLocked}
              >
                Cancel
              </button>
              <button
                type="button"
                className="month-booking-button month-booking-button--primary"
                onClick={() => { void saveBooking(); }}
                disabled={bookingModalIsLocked}
              >
                {bookingModalIsLocked ? "Saving..." : "Save"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
