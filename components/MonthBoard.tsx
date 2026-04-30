"use client";

import { useEffect, useRef, useState, type TouchEventHandler } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { summarizeBookedDayLabel, type MonthBoardData } from "@/lib/view";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";
import {
  buildGigDescription,
  buildLaJobSummary,
  parseGigDescription,
  parseLaJobSummary,
} from "@/lib/gigs";

interface Props {
  month: MonthBoardData;
  todayKey: string;
  initialEditorToken?: string;
  editorCalendarId?: string;
  prevHref?: string;
  nextHref?: string;
  canGoPrev?: boolean;
  canGoNext?: boolean;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CALL_TIME_OPTIONS = [
  "TBD",
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "10:00 AM",
  "11:00 AM",
  "12:00 PM",
  "1:00 PM",
  "2:00 PM",
  "3:00 PM",
  "4:00 PM",
  "5:00 PM",
] as const;

const STAGED_LOADING_COPY: ReadonlyArray<{ delay: number; text: string }> = [
  { delay: 0, text: "Updating calendar…" },
  { delay: 700, text: "Confirming with Google…" },
  { delay: 1800, text: "Refreshing schedule…" },
  { delay: 5000, text: "Google Calendar is taking a little longer…" },
];

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

type BookedLabel = ReturnType<typeof summarizeBookedDayLabel>;

interface ActiveDetailPanel {
  barKey: string;
  header: string;
  headerJobNumber?: string;
  details: BookedLabel["details"];
}

interface ActiveBookingPanel {
  mode: "create" | "edit";
  eventId?: string;
  date: string;
}

export function monthBarGridStyle(startDayIndex: number, endDayIndex: number, laneIndex: number): {
  gridColumn: string;
  gridRow: string;
} {
  return {
    gridColumn: `${startDayIndex + 1} / ${endDayIndex + 2}`,
    gridRow: String(laneIndex + 1),
  };
}

function stripJobPrefix(summary: string, jobNumber?: string): string {
  if (!jobNumber) return summary;
  const digits = jobNumber.replace(/\D/g, "");
  if (!digits) return summary;
  const stripped = summary
    .replace(new RegExp(`^\\s*LA\\s*#?\\s*${digits}\\b[\\s\\-–—:|]*`, "i"), "")
    .trim();
  return stripped.length > 0 ? stripped : summary;
}

function formatCompactDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc, LLL d");
}

function formatShortDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("LLL d");
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

function findEditableDetail(
  details: BookedLabel["details"],
  editorCalendarId?: string,
): BookedLabel["details"][number] | null {
  return details.find((detail) => {
    if ((detail.displayMode ?? "details") !== "details") return false;
    if (!detail.eventId) return false;
    if (editorCalendarId && detail.calendarId !== editorCalendarId) return false;
    return true;
  }) ?? null;
}

/**
 * Monthly board with compact multi-day event bars.
 */
export function MonthBoard({
  month,
  todayKey,
  initialEditorToken,
  editorCalendarId,
  prevHref,
  nextHref,
  canGoPrev = false,
  canGoNext = false,
}: Props) {
  const router = useRouter();
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
  const [resolvedEditorId, setResolvedEditorId] = useState<string | null>(null);
  const [activeBookingPanel, setActiveBookingPanel] = useState<ActiveBookingPanel | null>(null);
  const [bookingLaNumber, setBookingLaNumber] = useState("");
  const [bookingJobName, setBookingJobName] = useState("");
  const [bookingEndDate, setBookingEndDate] = useState("");
  const [bookingPickerMonthKey, setBookingPickerMonthKey] = useState("");
  const [bookingPickerExpanded, setBookingPickerExpanded] = useState(false);
  const [bookingCallTimeOption, setBookingCallTimeOption] = useState("TBD");
  const [bookingCallTimeOther, setBookingCallTimeOther] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [isBookingSavePending, setIsBookingSavePending] = useState(false);
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const stagedLoadingCopy = useStagedLoadingCopy(isBookingSavePending || isDeletePending);

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
      setResolvedEditorId(null);
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has("editor")) return;
    url.searchParams.delete("editor");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [initialEditorToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadEditorId() {
      try {
        const headers: Record<string, string> = {};
        if (editorToken) {
          headers.Authorization = `Bearer ${editorToken}`;
        }
        const response = await fetch("/api/editor/history?limit=1", {
          headers,
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (response.status === 401) {
          if (editorToken) {
            window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
            setEditorToken(null);
          }
          setResolvedEditorId(null);
          return;
        }
        if (!response.ok) return;
        const payload = await response.json() as { editorId?: string };
        const nextEditorId = typeof payload.editorId === "string"
          ? payload.editorId.trim().toLowerCase()
          : null;
        setResolvedEditorId(nextEditorId || null);
      } catch {
        // Keep existing editor id state on transient network issues.
      }
    }

    void loadEditorId();
    return () => {
      cancelled = true;
    };
  }, [editorToken]);

  const closeDetailPanel = () => setActiveDetailPanel(null);
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
    setBookingError(null);
    setIsBookingSavePending(false);
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
  };

  const editorModeActive = !!(editorToken || resolvedEditorId);
  const openBookingPanel = (date: string) => {
    const startMonthKey = DateTime.fromISO(date, { zone: "utc" }).toFormat("yyyy-LL");
    setActiveDetailPanel(null);
    setActiveBookingPanel({ mode: "create", date });
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate(date);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
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

    setActiveBookingPanel({
      mode: "edit",
      eventId: detail.eventId,
      date: startDate,
    });
    setBookingLaNumber(summary.jobNumber?.replace(/\D/g, "") ?? "");
    setBookingJobName(summary.jobName);
    setBookingEndDate(endDate);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption(parsedDescription.callTime && CALL_TIME_OPTIONS.includes(parsedDescription.callTime as (typeof CALL_TIME_OPTIONS)[number])
      ? parsedDescription.callTime
      : parsedDescription.callTime
        ? "Other"
        : "TBD");
    setBookingCallTimeOther(parsedDescription.callTime && !CALL_TIME_OPTIONS.includes(parsedDescription.callTime as (typeof CALL_TIME_OPTIONS)[number])
      ? parsedDescription.callTime
      : "");
    setBookingNotes(parsedDescription.jobNotes ?? "");
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

  async function saveBooking() {
    if (!activeBookingPanel || isBookingSavePending) return;
    if (!editorModeActive) {
      setBookingError("Editor token missing. Re-open the editor link.");
      return;
    }
    let summary: string;
    try {
      summary = buildLaJobSummary(bookingLaNumber, bookingJobName);
    } catch (error) {
      setBookingError(error instanceof Error ? error.message : "Invalid LA job details.");
      return;
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
    const callTime = bookingCallTimeOption === "Other"
      ? bookingCallTimeOther.trim()
      : bookingCallTimeOption.trim();
    if (bookingCallTimeOption === "Other" && !callTime) {
      setBookingError("Enter a custom Call Time or choose another option.");
      setIsBookingSavePending(false);
      return;
    }
    const description = buildGigDescription(callTime, bookingNotes);

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
          startDate,
          endDate,
        }),
      });

      if (response.ok) {
        closeBookingPanel();
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
        const payload = await response.json() as { message?: string };
        if (payload.message?.trim()) {
          message = payload.message.trim();
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
  const todayMonthKey = todayKey.slice(0, 7);
  const monthIsPast = month.monthKey < todayMonthKey;
  const allDays = month.weeks.flatMap((w) => w.days);
  const weekendToday = allDays.find((d) => d.date === todayKey && d.isWeekend);
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
  const canGoToPreviousBookingMonth = bookingStartMonth && bookingViewMonth
    ? bookingViewMonth > bookingStartMonth
    : false;
  const activeEditableDetail = activeDetailPanel
    ? findEditableDetail(activeDetailPanel.details, editorCalendarId)
    : null;
  const activeEditableSummary = activeEditableDetail
    ? parseLaJobSummary(activeEditableDetail.summary)
    : null;
  const activeEditableDescription = activeEditableDetail
    ? parseGigDescription(activeEditableDetail.description)
    : null;
  const activeOwnerEditor = activeEditableDetail?.ownerEditor?.trim().toLowerCase();
  const limitedEditorActive = resolvedEditorId === "milos";
  const limitedEditorBlocked = limitedEditorActive
    && (!activeOwnerEditor || activeOwnerEditor !== resolvedEditorId);
  const canManageActiveDetail = editorModeActive
    && !!activeEditableDetail
    && !limitedEditorBlocked;
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

  const onTouchStart: TouchEventHandler<HTMLElement> = (event) => {
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

  const onTouchMove: TouchEventHandler<HTMLElement> = (event) => {
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
      router.push(nextHref);
      return;
    }
    if (dx > 0 && canGoPrev && prevHref) {
      router.push(prevHref);
    }
  };

  const onTouchEnd: TouchEventHandler<HTMLElement> = () => {
    swipeRef.current.tracking = false;
  };

  const onTouchCancel: TouchEventHandler<HTMLElement> = () => {
    swipeRef.current.tracking = false;
  };

  return (
    <section
      className="month-board"
      aria-label={month.label}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div className="month-label-row">
        <h2 className="month-label period-label-animate">{month.label}</h2>
      </div>
      {weekendToday ? (
        <div className="month-weekend-today" aria-label={`Today: ${weekendToday.date}`}>
          <span className="month-day-num month-day-num--today">{weekendToday.dayOfMonth}</span>
          <span>Today</span>
        </div>
      ) : null}

      <div className="month-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="month-weekday">
            {label}
          </div>
        ))}
      </div>

      <div
        className="month-grid"
        role="grid"
        aria-label={`${month.label} schedule`}
        style={{ ["--month-week-count" as string]: String(month.weeks.length) }}
      >
        {month.weeks.map((week, weekIndex) => {
          const currentMonthIndexes = week.days
            .map((day, index) => (day.isCurrentMonth ? index : -1))
            .filter((index) => index >= 0);
          const currentMonthStartIndex = currentMonthIndexes[0] ?? -1;
          const currentMonthEndIndex = currentMonthIndexes[currentMonthIndexes.length - 1] ?? -1;
          const visibleBars = week.bars
            .filter((bar) => !bar.isPrivateUnavailable)
            .flatMap((bar) => {
              if (currentMonthStartIndex < 0 || currentMonthEndIndex < 0) {
                return [];
              }

              const clippedStartDayIndex = Math.max(bar.startDayIndex, currentMonthStartIndex);
              const clippedEndDayIndex = Math.min(bar.endDayIndex, currentMonthEndIndex);
              if (clippedStartDayIndex > clippedEndDayIndex) {
                return [];
              }

              return [{
                ...bar,
                startDayIndex: clippedStartDayIndex,
                endDayIndex: clippedEndDayIndex,
              }];
            });

          const laneIndexes = Array.from(new Set(visibleBars.map((bar) => bar.laneIndex))).sort((a, b) => a - b);
          const laneIndexMap = new Map(laneIndexes.map((laneIndex, compactLaneIndex) => [laneIndex, compactLaneIndex]));
          const laneCount = laneIndexes.length;
          const weekBarRows = laneCount;
          return (
            <section key={`${month.monthKey}-week-${weekIndex}`} className="month-week" role="row">
              <div
                className="month-week-body"
                style={{ ["--month-week-bar-rows" as string]: String(weekBarRows) }}
              >
                {visibleBars.length > 0 ? (
                  <div className="month-week-row-bars">
                    {visibleBars.map((bar) => {
                      const detailDate = bar.details[0]?.dateRangeLabel;
                      const safeAria = `${bar.label}${detailDate ? `, ${detailDate}` : ""}`;
                      const segmentPart = bar.startDayIndex === bar.endDayIndex
                        ? "single"
                        : "span";
                      const compactLaneIndex = laneIndexMap.get(bar.laneIndex) ?? 0;

                      return (
                        <button
                          key={bar.key}
                          type="button"
                          className={[
                            "month-row-bar",
                            `month-row-bar--${segmentPart}`,
                            "month-row-bar--details",
                          ].join(" ")}
                          style={monthBarGridStyle(bar.startDayIndex, bar.endDayIndex, compactLaneIndex)}
                          aria-label={safeAria}
                          onClick={() => {
                            closeBookingPanel();
                            if (activeDetailPanel?.barKey === bar.key) {
                              setActiveDetailPanel(null);
                              return;
                            }

                            const header = bar.jobNumber
                              ?? bar.details[0]?.summary
                              ?? bar.label
                              ?? "Busy";

                            setActiveDetailPanel({
                              barKey: bar.key,
                              header,
                              ...(bar.jobNumber ? { headerJobNumber: bar.jobNumber } : {}),
                              details: bar.details,
                            });
                          }}
                          aria-haspopup="dialog"
                          aria-expanded={activeDetailPanel?.barKey === bar.key}
                          aria-controls="month-job-detail-modal"
                          {...(!bar.isPrivateUnavailable && bar.title ? { title: bar.title } : {})}
                        >
                          <span className="month-row-bar-label">{bar.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="month-week-days">
                  {week.days.map((d, dayIndex) => {
                    const isPastCurrentMonthDay = d.isCurrentMonth && (monthIsPast || d.date < todayKey);
                    const bookedLabel = d.status === "booked"
                      ? summarizeBookedDayLabel(d.eventNames, d.eventDetails, d.bookedDisplay)
                      : null;
                    const canBookDay = editorModeActive
                      && d.isCurrentMonth
                      && !isPastCurrentMonthDay
                      && d.status === "available";
                    const hasCoveringBar = visibleBars.some(
                      (bar) => dayIndex >= bar.startDayIndex && dayIndex <= bar.endDayIndex,
                    );

                    return (
                      <article
                        key={d.date}
                        role="gridcell"
                        aria-label={`${d.date}: ${d.status === "booked" ? (bookedLabel?.label ?? "Busy") : "Available"}`}
                        tabIndex={canBookDay ? 0 : undefined}
                        onClick={canBookDay ? () => openBookingPanel(d.date) : undefined}
                        onKeyDown={canBookDay
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openBookingPanel(d.date);
                              }
                            }
                          : undefined}
                      className={[
                        "month-day",
                        d.status === "booked" ? "month-day--booked" : "month-day--available",
                        bookedLabel?.isPrivateUnavailable ? "month-day--booked-private" : "",
                        hasCoveringBar ? "month-day--occupied" : "",
                        isPastCurrentMonthDay ? "month-day--past" : "",
                        canBookDay ? "month-day--bookable" : "",
                        d.isToday ? "today" : "",
                        d.isCurrentMonth ? "current" : "outside",
                      ].filter(Boolean).join(" ")}
                      >
                        <div className={`month-day-num${d.isToday ? " month-day-num--today" : ""}`}>
                          {d.dayOfMonth}
                        </div>
                        {d.isCurrentMonth && !isPastCurrentMonthDay ? (
                          d.status === "available" ? (
                            canBookDay ? (
                              <span
                                className="month-day-book-button"
                                aria-hidden="true"
                              >
                                <span className="month-cell-label-full">Available</span>
                                <span className="month-cell-label-short">Avail</span>
                              </span>
                            ) : (
                              <div className="month-day-availability" aria-hidden="true">
                                <span className="month-cell-label-full">Available</span>
                                <span className="month-cell-label-short">Avail</span>
                              </div>
                            )
                          ) : bookedLabel?.isPrivateUnavailable ? (
                            <div className="month-day-unavailable-text" aria-hidden="true">
                              <span className="month-cell-label-full">Unavailable</span>
                              <span className="month-cell-label-short">Busy</span>
                            </div>
                          ) : hasCoveringBar ? (
                            <div className="month-day-placeholder" aria-hidden="true" />
                          ) : (
                            <div className="month-day-chip month-day-chip--booked" aria-hidden="true">
                              {bookedLabel?.label ?? "Busy"}
                            </div>
                          )
                        ) : (
                          <div className="month-day-placeholder" aria-hidden="true" />
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>

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
            id="month-job-detail-modal"
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-job-detail-title"
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

            <h3 id="month-job-detail-title" className="board-day-modal-title">
              {activeDetailPanel.header}
            </h3>

            {activeDetailPanel.details.length > 0 ? (
              <ul className="board-day-modal-events">
                {activeDetailPanel.details.map((detail, index) => {
                  const detailTitle = stripJobPrefix(detail.summary, activeDetailPanel.headerJobNumber);
                  const hideTitle = !activeDetailPanel.headerJobNumber
                    && (
                      detail.summary === "Unavailable"
                      || (activeDetailPanel.details.length === 1
                        && detail.summary === activeDetailPanel.header)
                    );
                  const detailParsedDescription = parseGigDescription(detail.description);

                  return (
                    <li
                      key={`${detail.summary}-${detail.dateRangeLabel ?? ""}-${detail.timeRangeLabel ?? ""}-${index}`}
                    >
                      {!hideTitle ? (
                        <p className="board-day-modal-event-title">{detailTitle}</p>
                      ) : null}
                      {detail.dateRangeLabel ? (
                        <p className="board-day-modal-event-date">{detail.dateRangeLabel}</p>
                      ) : null}
                      {detail.timeRangeLabel ? (
                        <p className="board-day-modal-event-meta">
                          <span className="board-day-modal-event-label">Time</span>{" "}
                          {detail.timeRangeLabel}
                        </p>
                      ) : null}
                      {detailParsedDescription.callTime ? (
                        <p className="board-day-modal-event-meta">
                          <span className="board-day-modal-event-label">Call</span>{" "}
                          {detailParsedDescription.callTime}
                        </p>
                      ) : null}
                      {detailParsedDescription.jobNotes ? (
                        <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                          <span className="board-day-modal-event-label">Notes</span>{" "}
                          {detailParsedDescription.jobNotes}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="board-day-modal-empty">No event details available.</p>
            )}

            {canManageActiveDetail ? (
              <div className="board-day-modal-actions">
                {showDeleteConfirm ? (
                  <div className="board-day-modal-confirm-delete">
                    <p className="board-day-modal-confirm-title">Delete this job?</p>
                    <p className="board-day-modal-confirm-copy">
                      This removes it from LA Jobs calendar.
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
            className="board-day-modal board-day-modal--booking"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-booking-title"
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

            <h3 id="month-booking-title" className="board-day-modal-title">
              Book Job
            </h3>
            <p className="board-day-modal-event-date">{bookingDateLabel}</p>

            <div className="month-booking-form">
              <label className="month-booking-label" htmlFor="booking-la-number">
                LA #
              </label>
              <div className="month-booking-la-field">
                <span className="month-booking-la-prefix" aria-hidden="true">LA#</span>
                <input
                  id="booking-la-number"
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

              <label className="month-booking-label" htmlFor="booking-job-title">
                Job Title
              </label>
              <input
                id="booking-job-title"
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

              <p className="month-booking-label">Date Range</p>
              <div className="month-booking-end-date-control">
                <button
                  type="button"
                  className={`month-booking-range-toggle${bookingPickerExpanded ? " is-open" : ""}`}
                  onClick={() => setBookingPickerExpanded((prev) => !prev)}
                  aria-expanded={bookingPickerExpanded}
                  aria-controls="month-booking-calendar-panel"
                  disabled={bookingModalIsLocked}
                >
                  <span>{bookingRangeLabel}</span>
                  <span className="month-booking-range-toggle-caret" aria-hidden="true">▾</span>
                </button>
                {bookingPickerExpanded && bookingCalendar && bookingViewMonth ? (
                  <div
                    id="month-booking-calendar-panel"
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
                      {WEEKDAY_LABELS.map((label) => (
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

              <label className="month-booking-label" htmlFor="booking-call-time">
                Call Time
              </label>
              <select
                id="booking-call-time"
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
                  id="booking-call-time-other"
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

              <label className="month-booking-label" htmlFor="booking-notes">
                Job Notes
              </label>
              <textarea
                id="booking-notes"
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
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
